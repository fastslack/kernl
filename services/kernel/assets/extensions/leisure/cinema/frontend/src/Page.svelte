<script lang="ts">
  /*
    /cinema — archive.org movie importer with poster-driven UI.

    Each item from archive.org has a canonical thumbnail at
    `https://archive.org/services/img/<identifier>` — we use it as the card
    background. Cards fade-in lazy, support hover zoom + selection toggle,
    and bulk import via the /api/cinema/media/import-archive/run endpoint.
  */
  import { onMount, tick } from 'svelte';
  import type { ExtPageContext } from './types.js';
  // Cue parsing, cue installation and caption styling are shared with /tv and
  // /torrents — this page used to carry its own copies of all three.
  import {
    parseVtt as parseVttShared, installCues,
    SubsController, type SubsAdapter, type SubTrack,
  } from '$shared/media/subs-client';
  import KernlPlayer from '$shared/media/KernlPlayer.svelte';
  import {
    loadCaptionStyle, saveCaptionStyle, captionInlineStyle as capStyleOf,
    CAPTION_FAMILIES as SHARED_FAMILIES,
    type CaptionStyle,
  } from '$shared/media/caption-style';

  /** Host-provided context — auth token, locale, navigation. */
  export let ctx: ExtPageContext;

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

  interface ArchiveItem {
    identifier: string;
    title: string;
    date?: string;
    creator?: string;
    description?: string;
    subject?: string[];
    collection?: string[];
    downloads?: number;
    runtime_sec?: number;
  }

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
  // Language ISO 2-letter code, empty = any.
  let langFilter = '';
  // Sort dropdown — exposed inline so the user doesn't have to dig.
  let sortMode: 'downloads' | 'year_desc' | 'year_asc' | 'added_desc' | 'rating' = 'downloads';

  // ── Top-tag chip row ─────────────────────────────────────────
  // Populated from /api/cinema/tags. Cached at module scope so reloading
  // /cinema doesn't re-fetch the same data, but refresh on demand after
  // a big ingest via the "Embed all" panel below.
  interface CinemaTag { tag_norm: string; tag_display: string; count: number; rank: number; }
  let topTags: CinemaTag[] = [];
  let tagsLoading = false;
  async function loadTopTags(): Promise<void> {
    tagsLoading = true;
    try {
      const r = await apiFetch('/api/cinema/tags?limit=30');
      if (r.ok) {
        const body = await r.json();
        topTags = (body.tags ?? []) as CinemaTag[];
      }
    } catch { /* non-fatal — chip row stays empty */ }
    finally { tagsLoading = false; }
  }
  function pickTag(tag: string) {
    if (activeTags.includes(tag)) {
      activeTags = activeTags.filter(t => t !== tag);
    } else {
      activeTags = [...activeTags, tag];
    }
    runSearch();
  }
  function clearTags() {
    activeTags = [];
    runSearch();
  }
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
        const r = await apiFetch(`/api/cinema/tags?q=${encodeURIComponent(q)}&limit=20`);
        if (r.ok) {
          const body = await r.json();
          tagSearchHits = (body.tags ?? []) as CinemaTag[];
        }
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

  // ── "+ to directory" popover ───────────────────────────────────
  // Lightweight: click the 📁 icon on a card → small floating list of
  // your local directories. Click one → POST add-item. "+ new" goes
  // to /cinema/directories where the form lives.
  interface MyDirectorySummary { id: string; title: string; item_count: number; }
  let myDirs: MyDirectorySummary[] = [];
  let dirPopoverFor: string | null = null;     // identifier of the card whose popover is open
  let dirPopoverBusy = false;
  let dirPopoverNotice = '';
  async function ensureMyDirsLoaded() {
    if (myDirs.length > 0) return;
    try {
      const r = await apiFetch('/api/cinema/directories?origin=local&limit=200');
      if (r.ok) {
        const body = await r.json();
        myDirs = (body.directories ?? []).map((d: any) => ({
          id: d.id, title: d.title, item_count: d.item_count ?? d.items?.length ?? 0,
        }));
      }
    } catch { /* */ }
  }
  async function openDirPopover(identifier: string, ev: Event) {
    ev.stopPropagation();
    dirPopoverNotice = '';
    dirPopoverFor = dirPopoverFor === identifier ? null : identifier;
    if (dirPopoverFor) await ensureMyDirsLoaded();
  }
  async function addToDir(dirId: string, identifier: string) {
    dirPopoverBusy = true;
    dirPopoverNotice = '';
    try {
      const r = await apiFetch(`/api/cinema/directories/${encodeURIComponent(dirId)}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        dirPopoverNotice = `✗ ${e.error ?? 'falló'}`;
        return;
      }
      dirPopoverNotice = '✓ agregada';
      // optimistic count bump
      myDirs = myDirs.map(d => d.id === dirId ? { ...d, item_count: d.item_count + 1 } : d);
      // close after a short visual confirmation
      setTimeout(() => { if (dirPopoverFor === identifier) dirPopoverFor = null; }, 700);
    } catch (err: any) {
      dirPopoverNotice = `✗ ${err?.message ?? err}`;
    } finally { dirPopoverBusy = false; }
  }
  function closeDirPopover() { dirPopoverFor = null; dirPopoverNotice = ''; }

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
      const r = await apiFetch('/api/cinema/embed/status');
      if (r.ok) embedSnap = await r.json();
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
      const r = await apiFetch('/api/cinema/embed/stop', { method: 'POST' });
      if (r.ok) embedSnap = await r.json();
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
  let hoverItem: string | null = null;
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
      const r = await apiFetch('/api/cinema/titles?watchlist=1&limit=200');
      if (r.ok) {
        const body = await r.json();
        serverItems = (body.items ?? []).map((t: any) => ({
          identifier: t.identifier,
          title: t.title,
          date: t.date,
          creator: t.creator,
          description: t.description,
          subject: t.subject,
          addedAt: t.last_seen_at ? new Date(t.last_seen_at).getTime() : Date.now(),
        }));
      }
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
  interface PlayFile { name: string; size: number; format: string; length: string; kind: string; }
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

  // ── Subtitle / translation state ───────────────────────────
  interface SubLang { iso: string; name: string; }
  interface SubChainLink { slug: string; provider: string; model: string; available: boolean; }
  interface SubEngineInfo {
    engines: {
      nllb: { available: boolean; model: string; offline: boolean };
      llm:  { available: boolean; primary: SubChainLink; fallbacks: SubChainLink[] };
    };
    languages: SubLang[];
  }
  let subInfo: SubEngineInfo | null = null;

  // Helper: short label for the engine picker (e.g. "Qwen 2.5 7B" → keeps
  // it compact in the button). Strips org prefix and trailing -gguf.
  function shortModel(model?: string): string {
    if (!model) return '';
    const stripped = model.replace(/^[^/]+\//, '').replace(/\.gguf$/i, '');
    return stripped.length > 18 ? stripped.slice(0, 17) + '…' : stripped;
  }
  // ── Subtitle UI state ──────────────────────────────────────────────
  // We keep two intent vars (`subSource`, `translateActive`) and derive
  // the internal `subTrack` value from them. That way the settings UI is
  // cleanly split into "where do subtitles come from?" and "do we
  // translate them?", but the URL-builder logic in `trackSrc()` keeps
  // its existing flat string vocabulary.
  type SubSource = 'off' | 'orig' | 'auto';
  let subSource: SubSource = 'off';
  let translateActive = false;
  // Internal: the current subtitle "track" identifier the URL builder
  // understands. Computed reactively from (subSource, translateActive,
  // subTargetLang, subEngine). DO NOT set this directly from UI — set
  // subSource / translateActive instead.
  let subTrack: string = 'off';
  // Engine = which translation PATH to use. The actual provider/model
  // under "llm" is decided by the chain configured at /models (and may
  // fall back automatically on quota/auth errors). "nllb" stays as the
  // offline escape hatch.
  let subEngine: 'nllb' | 'llm' = 'llm';
  // ── Apply gate ────────────────────────────────────────────────
  // The wizard now sets all params (source / target lang / engines)
  // up front and the user clicks ONE CTA at the bottom to run the
  // whole pipeline. `subsApplied` is the single gate — when false,
  // trackSrc() returns '' so no fetch fires; when true, the URL
  // builds from the current config and the loader takes it from
  // there. Reset whenever the video or the source mode changes
  // (the user has to confirm again for the new context).
  let subsApplied = false;
  // Explicit consent gate for WHISPER transcription. Opening a video must
  // NEVER auto-run whisper (a 141MB model download on first use + a full
  // CPU transcription of the film). trackSrc() only returns the generating
  // `/subs` pipeline URL when this is true, and it's set ONLY by an explicit
  // APPLY / generate click. Auto-open may still display subs that are ALREADY
  // materialized (cached VTT, shipped .srt) — those don't touch whisper.
  let generateRequested = false;
  let advancedOpen = false;       // collapsed by default — keep UI minimal
  let generateOpen = false;       // legacy collapsible flag (unused after the
                                   // mode-based redesign — kept null-safe)
  // Two-mode design — the user only ever sees ONE simple screen at a
  // time. 'select' is the default: just a list of available subs + a
  // "+ Generate" button. 'generate' is a tiny config-and-run form that
  // takes over the panel. After Start, we auto-close the popover and
  // show progress via the centred modal.
  type SubsMode = 'select' | 'generate';
  let subsMode: SubsMode = 'select';
  // (Legacy modalPhaseSwapTimer removed — the auto+translate flow now
  //  uses 2 sequential frontend fetches so the modal swap is exact.)
  let modalPhaseSwapTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Cached subs index ─────────────────────────────────────────────
  // List of subtitle files already produced for the current video URL.
  // Populated by GET /api/cinema/media/subs/list?url=… and refreshed after
  // every successful generation. Drives the "USE EXISTING" pill row.
  interface CachedSub {
    key: string;                 // sha1 hash → URL: /api/cinema/media/subs/file/<key>.vtt
    kind: 'transcribe' | 'translation' | 'shipped';
    src_lang: string;
    tgt_lang: string;
    engine?: string;             // whisper engine for transcribe; LLM engine for translation
    model?: string;
    cue_count?: number;
    created_at?: number;
  }
  let cachedSubs: CachedSub[] = [];
  // The currently-applied sub identifier — drives the "selected" highlight
  // in the SELECT row. 'off' / 'shipped' / a CachedSub.key.
  let activeSubKey: string = 'off';

  // ── Federated subtitle marketplace (Stage 4b) ────────────────────
  // Mirrors the cinema_subs_index server-side. Each row is an
  // announcement seen on a discovery provider (Nostr, archive.org).
  // Click "bajar" → POST /api/cinema/subs/download → bytes land in the
  // legacy data/subtitles/ cache → refreshCachedSubs picks it up so the
  // user can activate it from the regular SELECT row.
  interface FederatedSubRow {
    rowId: string;
    providerId: string;
    providerEventId: string;
    identifier: string;
    srcLang: string;
    tgtLang: string;
    engine: string;
    signerPubkey: string;
    webseedUrl: string;
    sha256: string;
    sizeBytes: number;
    content: string;
    observedAt: string;
    downloadedSubId: string | null;
  }
  let federatedSubs: FederatedSubRow[] = [];
  let federatedRefreshing = false;
  let federatedTrustOnly = false;
  let federatedError = '';
  // Trust map keyed by signer pubkey (hex). Populated alongside the
  // federated rows. Values: mine | trusted | blocked | unknown.
  let publishersMap: Record<string, { trust: string; alias: string }> = {};
  // Per-row download progress so we can disable the button while in
  // flight without needing a global busy flag.
  let downloadingRowIds = new Set<string>();
  // Group federated rows for the UI: expose computed lists rather than
  // recomputing inline in the markup. Reactivity drives them.
  $: federatedShown = federatedTrustOnly
    ? federatedSubs.filter(r => (publishersMap[r.signerPubkey]?.trust ?? 'unknown') === 'trusted'
                              || (publishersMap[r.signerPubkey]?.trust ?? 'unknown') === 'mine')
    : federatedSubs;
  // Count of subtitle tracks immediately available for the current video
  // — drives the small badge on the CC button so the user knows there
  // are options before opening Settings. Federated rows that aren't
  // downloaded yet don't count (they require an explicit "bajar" click).
  $: subsAvailableCount = cachedSubs.length;

  async function loadFederatedSubs(refresh = false): Promise<void> {
    if (!playItem) return;
    federatedError = '';
    if (refresh) federatedRefreshing = true;
    try {
      const url = `/api/cinema/subs/by-video/${encodeURIComponent(playItem.identifier)}${refresh ? '?refresh=1' : ''}`;
      const r = await apiFetch(url);
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        federatedError = e.error ?? `http ${r.status}`;
        return;
      }
      const body = await r.json();
      federatedSubs = Array.isArray(body?.federated) ? body.federated : [];
      publishersMap = body?.publishers ?? {};
      console.log('[cinema] loadFederatedSubs:', federatedSubs.length, 'rows', refresh ? '(refreshed)' : '(cached)');
    } catch (err: any) {
      federatedError = err?.message ?? String(err);
    } finally {
      federatedRefreshing = false;
    }
  }

  async function downloadFederated(row: FederatedSubRow): Promise<void> {
    if (downloadingRowIds.has(row.rowId)) return;
    downloadingRowIds = new Set(downloadingRowIds).add(row.rowId);
    try {
      const r = await apiFetch('/api/cinema/subs/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rowId: row.rowId }),
      });
      const body = await r.json().catch(() => ({} as any));
      if (!r.ok) {
        federatedError = body.error ?? `http ${r.status}`;
        return;
      }
      // Refresh both views so the new sub shows up in the regular cached
      // list AND the index marks the federated row as downloaded.
      await Promise.all([refreshCachedSubs(), loadFederatedSubs(false)]);
      // Auto-activate the freshly-downloaded sub via the existing path.
      if (body.cache_key) {
        const cs = cachedSubs.find(c => c.key === body.cache_key);
        if (cs) selectCachedSub(cs);
      }
    } catch (err: any) {
      federatedError = err?.message ?? String(err);
    } finally {
      const next = new Set(downloadingRowIds);
      next.delete(row.rowId);
      downloadingRowIds = next;
    }
  }

  async function setPublisherTrust(pubkey: string, trust: 'mine' | 'trusted' | 'blocked' | 'unknown'): Promise<void> {
    try {
      const r = await apiFetch('/api/cinema/subs/trust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pubkey, trust }),
      });
      if (!r.ok) return;
      const body = await r.json().catch(() => ({} as any));
      // Patch the local map so the UI reflects the change without re-fetching.
      publishersMap = { ...publishersMap, [pubkey]: { trust: body?.publisher?.trust ?? trust, alias: body?.publisher?.alias ?? '' } };
    } catch { /* non-fatal */ }
  }

  function shortPubkey(pk: string): string {
    if (!pk) return '—';
    return pk.slice(0, 8) + '…' + pk.slice(-4);
  }

  function fmtBytesShort(n: number): string {
    if (!n) return '—';
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
    return `${n} B`;
  }

  /**
   * Cinema's caption backend as a shared-module adapter.
   *
   * The gnarly part is fetchVtt: a "track" here can be one of three things and
   * each resolves differently. That logic is cinema-specific and stays here —
   * the adapter exists precisely so the shared controller never has to know.
   */
  let subsCtl: SubsController | null = null;
  let subsTick = 0;

  function cinemaAdapter(): SubsAdapter {
    return {
      async listTracks(): Promise<SubTrack[]> {
        if (!playItem || !playFiles[playActiveIdx]) return [];
        const upstream = archiveDownloadUrl(playItem.identifier, playFiles[playActiveIdx].name);
        let fromBackend: CachedSub[] = [];
        try {
          const r = await apiFetch(`/api/cinema/media/subs/list?url=${encodeURIComponent(upstream)}`);
          if (r.ok) {
            const j = await r.json();
            fromBackend = (Array.isArray(j?.subs) ? j.subs : []) as CachedSub[];
          }
        } catch { /* non-fatal */ }

        // Subtitle files shipped inside the archive item itself need no
        // transcribe at all — merge them in as synthetic entries.
        const shipped = detectShippedSubs(playFiles).map<CachedSub>((sh) => ({
          key: sh.key,
          kind: 'transcribe',
          src_lang: sh.lang || subSourceLang,
          tgt_lang: sh.lang || subSourceLang,
          engine: 'shipped',
          model: sh.file.name,
          cue_count: 0,
          created_at: 0,
        }));
        const merged: CachedSub[] = [...shipped];
        const have = new Set(merged.map((x) => x.key));
        for (const b of fromBackend) if (!have.has(b.key)) { merged.push(b); have.add(b.key); }

        return merged.map((cs) => ({
          id: cs.key,
          lang: cs.kind === 'translation' ? cs.tgt_lang : cs.src_lang,
          label: cs.kind === 'translation'
            ? `${cs.src_lang} → ${cs.tgt_lang}`
            : cs.engine === 'shipped'
              ? `${cs.src_lang} · incluido`
              : `${cs.src_lang} · original`,
          kind: cs.engine === 'shipped' ? 'shipped' : cs.kind,
          srcLang: cs.src_lang,
          createdAt: cs.created_at || undefined,
          raw: cs,
        }));
      },

      async fetchVtt(track): Promise<string> {
        const cs = track.raw as CachedSub;
        let fetchUrl: string;
        if (cs.key.startsWith('shipped:') && playItem) {
          // The item ships its own .srt — just convert it, no model involved.
          const filename = cs.model || cs.key.slice('shipped:'.length);
          if (!filename) throw new Error('shipped sub without a filename');
          const upstream = `https://archive.org/download/${encodeURIComponent(playItem.identifier)}/${filename.split('/').map(encodeURIComponent).join('/')}`;
          const params = new URLSearchParams({
            url: upstream,
            src: cs.src_lang || subSourceLang,
            tgt: cs.src_lang || subSourceLang,
            passthrough: '1',
          });
          fetchUrl = `/api/cinema/media/translate-srt?${params.toString()}`;
        } else if (cs.key.startsWith('local:') && playItem && playFiles[playActiveIdx]) {
          // No backend sidecar — re-derive the pipeline URL from cached params.
          const file = playFiles[playActiveIdx];
          const upstream = archiveDownloadUrl(playItem.identifier, file.name);
          const willTranslate = cs.kind === 'translation' && cs.tgt_lang !== cs.src_lang;
          const params = new URLSearchParams({
            url: upstream,
            lang: cs.src_lang,
            transcribe_engine: transcribeEngine,
            transcribe_model: cs.model || transcribeModel,
          });
          if (willTranslate) {
            params.set('tgt', cs.tgt_lang);
            params.set('translate_engine', cs.engine || subEngine);
          }
          fetchUrl = `/api/cinema/media/subs?${params.toString()}`;
        } else {
          fetchUrl = `/api/cinema/media/subs/file?key=${cs.key}`;
        }

        const r = await apiFetch(fetchUrl);
        if (!r.ok) throw new Error(`sub fetch ${r.status}`);
        const vtt = await r.text();

        // Keep the wizard in step so the CC state and the pickers agree.
        translateActive = cs.kind === 'translation';
        if (cs.kind === 'translation') subTargetLang = cs.tgt_lang;
        subSourceLang = cs.src_lang;
        subsApplied = true;
        lastLoadedTrackUrl = fetchUrl;
        return vtt;
      },

      async remove(track) {
        const r = await apiFetch(`/api/cinema/media/subs/file?key=${encodeURIComponent(track.id)}`, {
          method: 'DELETE',
        });
        if (!r.ok) throw new Error(`delete ${r.status}`);
      },

      /**
       * Auto-pick on open. `local:` entries have no materialized VTT —
       * resolving one hits the pipeline, which can run whisper, so it must
       * never be chosen unprompted.
       */
      preferred: (tracks) =>
        tracks.find((t) => !t.id.startsWith('local:') && t.kind === 'translation' && t.lang === subTargetLang)
        ?? tracks.find((t) => !t.id.startsWith('local:') && t.kind !== 'translation')
        ?? null,
    };
  }

  /** Rebuild the controller for the current item + file, and load its tracks. */
  async function refreshCachedSubs(): Promise<void> {
    if (!playItem || !playFiles[playActiveIdx]) return;
    if (!subsCtl) {
      subsCtl = new SubsController(cinemaAdapter(), () => { subsTick++; });
    }
    if (videoEl) subsCtl.setVideo(videoEl);
    // autoSelect only when nothing is on screen yet — never yank a sub the
    // viewer explicitly chose.
    await subsCtl.refresh({ autoSelect: !subsApplied });
    subsTick++;
  }

  async function applySubs() {
    console.log('[cinema] applySubs: confirmed', { subSource, translateActive, subTargetLang, subEngine, transcribeEngine, transcribeModel });
    // Auto-pick path: if the LLM chain (configured at /models) has any
    // usable link, use it; otherwise fall back to offline NLLB. Provider
    // selection inside "llm" is the chain's job — quota/auth fallbacks
    // happen there transparently.
    if (translateActive && subTargetLang !== subSourceLang && !advancedOpen) {
      subEngine = subInfo?.engines.llm.available ? 'llm' : 'nllb';
      console.log(`[cinema] auto-picked engine: ${subEngine}`);
    }
    const willTranslate = translateActive && subTargetLang !== subSourceLang;
    subsApplied = true;
    // Explicit user consent to run whisper (this is the only place that sets
    // it). trackSrc() gates the generating /subs pipeline on this flag, so
    // opening a video never auto-downloads the model.
    if (subSource === 'auto') generateRequested = true;
    // Auto-close the settings popover so the user has an unobstructed
    // view of the centred progress modal. Also flip the wizard back to
    // SELECT mode so the next time they open settings the new sub will
    // be there as a highlighted pill.
    settingsOpen = false;
    subsMode = 'select';
    // The user wants the video paused at 0:00 while we generate, then
    // auto-resumed once captions are loaded. Otherwise they'd waste
    // minutes of the film while staring at a "Transcribing…" modal,
    // and miss the cues for the parts that already played.
    pauseAndRewindForGeneration();
    if (subSource === 'auto' && willTranslate && playItem && playFiles[playActiveIdx]) {
      await runAutoTranslatePipeline();
      return;
    }
    // Other paths: single call via trackSrc → loadTranscriptManual.
    if (subSource === 'auto') startProgress('transcribe');
    else if (willTranslate) startProgress('translate');
    await tick();
    console.log('[cinema] applySubs: triggering maybeLoadTranscript');
    maybeLoadTranscript();
  }

  // Whether we paused-and-rewound the video for an in-flight generation.
  // The post-load auto-resume only fires when this is true so we don't
  // restart playback on cache hits (where the user never even noticed).
  let resumeAfterSubs = false;
  function pauseAndRewindForGeneration(): void {
    if (!videoEl) { resumeAfterSubs = false; return; }
    const wasPlaying = !videoEl.paused && !videoEl.ended;
    // "Hasn't started yet" (paused at 0) counts as want-to-play — the
    // user opened the player, presumably to watch. Otherwise respect
    // intentional mid-film pause.
    const neverStarted = videoEl.paused && videoEl.currentTime < 0.5;
    try {
      videoEl.pause();
      videoEl.currentTime = 0;
    } catch { /* */ }
    resumeAfterSubs = wasPlaying || neverStarted;
    console.log('[cinema] pauseAndRewindForGeneration:', { wasPlaying, neverStarted, resume: resumeAfterSubs });
  }
  function resumePlaybackIfArmed(): void {
    if (!videoEl || !resumeAfterSubs) return;
    resumeAfterSubs = false;
    // Slight delay so the cuechange fires for cue 0 before play starts.
    setTimeout(() => {
      if (videoEl) videoEl.play().catch(() => { /* user gesture may be required */ });
    }, 80);
  }

  // Two-phase orchestrator for auto-generate + translate. Runs
  // /transcribe (modal: "Transcribing audio…") then /translate-srt
  // pointing at the cached transcribe output (modal swaps to
  // "Translating to X…"). Installs cues at the end. Each phase has
  // its own modal state so the visual swap matches reality.
  async function runAutoTranslatePipeline(): Promise<void> {
    const item = playItem; const file = playFiles[playActiveIdx];
    if (!item || !file) return;
    const upstream = archiveDownloadUrl(item.identifier, file.name);
    if (inflightAbort) { try { inflightAbort.abort(); } catch { /* */ } }
    inflightAbort = new AbortController();
    const myAbort = inflightAbort;
    // Block the reactive maybeLoadTranscript from racing us by claiming
    // the URL it would compute. trackSrc() returns the unified /subs
    // URL for this config — match it so the dedup skips during our run.
    const blockerUrl = trackSrc();
    if (blockerUrl) { inflightTrackUrl = blockerUrl; }

    // ── Phase 1: SHIPPED-FIRST optimization OR whisper ─────────────
    // If the archive item ships its own subtitle in the source language,
    // SKIP whisper entirely and use that file (huge time saver — minutes
    // → seconds). Otherwise run whisper from scratch. Both branches end
    // with `transcribedVtt` populated and `phase1UpstreamUrl` pointing
    // at the URL Phase 2's translate-srt should fetch as input.
    const shipped = detectShippedSubs(playFiles);
    const shippedSrc = shipped.find((s) => s.lang === subSourceLang)
      ?? shipped.find((s) => s.lang === '');
    let transcribedVtt: string;
    let phase1UpstreamUrl: string;
    startProgress('transcribe');
    if (shippedSrc) {
      console.log('[cinema] runAutoTranslatePipeline: using shipped sub instead of whisper:', shippedSrc.file.name);
      const shippedUpstream = `https://archive.org/download/${encodeURIComponent(item.identifier)}/${shippedSrc.file.name.split('/').map(encodeURIComponent).join('/')}`;
      phase1UpstreamUrl = shippedUpstream;
      const shippedParams = new URLSearchParams({
        url: shippedUpstream, src: subSourceLang, tgt: subSourceLang, passthrough: '1',
      });
      try {
        const r = await apiFetch(`/api/cinema/media/translate-srt?${shippedParams.toString()}`, {
          credentials: 'omit', signal: myAbort.signal,
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({} as any));
          stopProgress(e.error ?? `shipped sub fetch http ${r.status}`);
          return;
        }
        transcribedVtt = await r.text();
        transcribeAvailable = true;
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        stopProgress(`shipped sub fetch failed: ${err?.message ?? String(err)}`);
        return;
      }
    } else {
      const transcribeParams = new URLSearchParams({
        url: upstream, engine: transcribeEngine, model: transcribeModel, lang: subSourceLang,
      });
      // startProgress('transcribe') opened the SSE — forward its jobId so
      // the kernel pushes whisper.cpp's per-percent progress to the bar.
      if (subsJobId) transcribeParams.set('jobId', subsJobId);
      const transcribeRoute = `/api/cinema/media/transcribe?${transcribeParams.toString()}`;
      // For Phase 2, translate-srt will fetch the cached transcribe via
      // the kernel's own URL (handled by its localhost-rewrite logic).
      phase1UpstreamUrl = `${window.location.origin}${transcribeRoute}`;
      try {
        const r = await apiFetch(transcribeRoute, { credentials: 'omit', signal: myAbort.signal });
        if (!r.ok) {
          const e = await r.json().catch(() => ({} as any));
          stopProgress(e.error ?? `transcribe http ${r.status}`);
          return;
        }
        transcribedVtt = await r.text();
        const cueHdr = r.headers.get('x-transcribe-cues');
        if (cueHdr) transcribeCueCount = parseInt(cueHdr, 10);
        transcribeAvailable = true;
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        stopProgress(`transcribe failed: ${err?.message ?? String(err)}`);
        return;
      }
    }

    // Phase 2: translate. Same regardless of whether Phase 1 used
    // shipped or whisper — the translate-srt endpoint just needs an
    // upstream URL it can fetch.
    stopProgress();
    startProgress('translate');
    const translateParams = new URLSearchParams({
      url: phase1UpstreamUrl,
      src: subSourceLang,
      tgt: subTargetLang,
      engine: subEngine,
    });
    // startProgress('translate') opens the SSE channel; forward its jobId
    // so the kernel publishes batch progress onto it.
    if (subsJobId) translateParams.set('jobId', subsJobId);
    const translateUrl = `/api/cinema/media/translate-srt?${translateParams.toString()}`;
    // (Same: keep blockerUrl active for dedup; don't replace it.)
    let finalVtt: string;
    try {
      const r = await apiFetch(translateUrl, { credentials: 'omit', signal: myAbort.signal });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        stopProgress(e.error ?? `translate http ${r.status}`);
        return;
      }
      finalVtt = await r.text();
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      stopProgress(`translate failed: ${err?.message ?? String(err)}`);
      return;
    } finally {
      if (inflightAbort === myAbort) inflightAbort = null;
      // The dedup blocker is cleared at the very end (see below) once
      // cues are installed. Don't clear here — would let a racing
      // reactive re-fetch the same data.
    }

    // Install cues. Done — clear progress and refresh the cached subs
    // list (so the new translation appears in the SELECT row).
    stopProgress();
    installVttCues(finalVtt);
    // Mark the trackSrc URL as loaded so the reactive doesn't refetch.
    if (blockerUrl) { lastLoadedTrackUrl = blockerUrl; }
    inflightTrackUrl = '';
    // installVttCues already called ensureCurrentSubInCacheList which
    // adds a synthetic entry if the backend doesn't list this sub.
    // refreshCachedSubs runs after for backend-truth updates.
    await refreshCachedSubs();
    ensureCurrentSubInCacheList();
    // Cues are installed → resume from 0:00 with subs visible.
    resumePlaybackIfArmed();
  }

  // ── SELECT row handlers ───────────────────────────────────────────
  // These let the user instantly switch to any sub already in the cache,
  // bypassing the GENERATE flow entirely. They're only available when
  // the corresponding subtitle data exists.
  function selectOff(): void {
    activeSubKey = 'off';
    subSource = 'off';
    subsApplied = false;
    if (manualTrack) {
      while (manualTrack.cues && manualTrack.cues.length > 0) {
        manualTrack.removeCue(manualTrack.cues[0]);
      }
      manualTrack.mode = 'disabled';
    }
    activeCueText = '';
    lastLoadedTrackUrl = '';
  }
  function selectShipped(): void {
    activeSubKey = 'shipped';
    subSource = 'orig';
    translateActive = false;
    subsApplied = true;
    // The reactive will pick up subSource change and load via trackSrc.
  }
  /**
   * Put a cached sub on screen. The three-way URL resolution lives in the
   * adapter now; this only guards the auto-open case.
   */
  async function selectCachedSub(cs: CachedSub, auto = false): Promise<void> {
    // `local:` has no materialized VTT — resolving it can run whisper, which
    // must never happen unprompted on open.
    if (auto && cs.key.startsWith('local:') && !generateRequested) {
      activeSubKey = 'off';
      return;
    }
    if (!subsCtl) await refreshCachedSubs();
    const track = subsCtl?.tracks.find((t) => t.id === cs.key);
    if (track) await subsCtl?.show(track);
    subsTick++;
  }

  /**
   * Display a VTT the pipelines already produced. Goes through the shared
   * controller so the track list, the CC state and what's on screen can't
   * drift apart — they used to be three separate sources of truth.
   */
  function installVttCues(rawVtt: string): void {
    if (!videoEl) return;
    if (!subsCtl) subsCtl = new SubsController(cinemaAdapter(), () => { subsTick++; });
    subsCtl.setVideo(videoEl);
    subsCtl.showVtt(rawVtt, { lang: subSourceLang || 'en' });
    subsTick++;
    // The backend list may not report a just-generated sub yet — keep the
    // synthetic fallback so the viewer can still toggle it.
    ensureCurrentSubInCacheList();
  }

  // Push a synthetic entry to cachedSubs if there's no real match.
  // The synthetic key is deterministic per (kind, src, tgt, engine) so
  // re-runs don't duplicate. selectCachedSub uses the saved
  // trackSrc-derived URL — but for synthetic entries we re-derive at
  // click time from current state.
  function ensureCurrentSubInCacheList(): void {
    const willTranslate = translateActive && subTargetLang !== subSourceLang;
    const kind: 'translation' | 'transcribe' = willTranslate ? 'translation' : 'transcribe';
    const tgt = willTranslate ? subTargetLang : subSourceLang;
    const eng = willTranslate ? subEngine : transcribeEngine;
    const syntheticKey = `local:${kind}:${subSourceLang}:${tgt}:${eng}:${transcribeModel}`;
    const exists = cachedSubs.some(c =>
      c.kind === kind && c.src_lang === subSourceLang && c.tgt_lang === tgt && c.engine === eng
    );
    if (exists) {
      // Real entry already there — make sure it's the active one.
      const m = cachedSubs.find(c =>
        c.kind === kind && c.src_lang === subSourceLang && c.tgt_lang === tgt && c.engine === eng
      );
      if (m) activeSubKey = m.key;
      return;
    }
    cachedSubs = [...cachedSubs, {
      key: syntheticKey,
      kind,
      src_lang: subSourceLang,
      tgt_lang: tgt,
      engine: eng,
      model: transcribeModel,
      cue_count: manualTrack?.cues?.length ?? 0,
      created_at: Date.now(),
    }];
    activeSubKey = syntheticKey;
    console.log('[cinema] ensureCurrentSubInCacheList: synthetic entry added', syntheticKey);
  }
  // (Reset of `subsApplied` is handled explicitly in openPlayer(),
  // selectPlayFile(), closePlayer(), and the source-pill click handlers
  // — a reactive `$: subsApplied = false` block was racing the cache-hit
  // logic in openPlayer() and clobbering subsApplied=true after it was
  // legitimately set.)
  let subTargetLang: string = 'es';
  let subSourceLang: string = 'en';

  $: {
    void subSource; void translateActive; void subTargetLang; void subEngine;
    if (subSource === 'off') {
      subTrack = 'off';
    } else if (subSource === 'orig' && !translateActive) {
      subTrack = 'orig';
    } else if (subSource === 'orig' && translateActive) {
      // Any string that isn't off/orig/transcribed/transcribed-translated
      // routes through translate-srt with the shipped .srt as upstream.
      subTrack = `${subTargetLang}-${subEngine}`;
    } else if (subSource === 'auto' && !translateActive) {
      subTrack = 'transcribed';
    } else if (subSource === 'auto' && translateActive) {
      subTrack = 'transcribed-translated';
    }
  }

  async function loadSubInfo() {
    if (subInfo) return;
    try {
      const r = await apiFetch('/api/cinema/media/translate-srt/info');
      if (r.ok) {
        subInfo = await r.json();
        // Pick a sane default engine based on what's actually available.
        // Order: lmstudio > ollama > grok > nllb. If user later opens
        // Advanced and picks a different one, that takes precedence.
        subEngine = subInfo?.engines.llm.available ? 'llm' : 'nllb';
        console.log('[cinema] loadSubInfo: default engine →', subEngine,
          subInfo?.engines.llm.available ? `(primary=${subInfo.engines.llm.primary.slug})` : '');
      }
    } catch { /* keep null */ }
  }

  // ── Transcribe (auto-generate SRT from video) ──────────────────────
  interface TranscribeInfo {
    engines: {
      transformers: { available: boolean; model: string; offline: boolean; hint: string };
      whispercpp: { available: boolean; hint: string };
      groq: { available: boolean; model: string; hint: string };
    };
    models: string[];
  }
  let transcribeInfo: TranscribeInfo | null = null;
  let transcribeBusy = false;
  let transcribeError = '';
  // ISO of the engine actually used to generate this run, for the track label.
  let transcribeAvailable = false;
  let transcribeEngine: 'whispercpp' | 'transformers' | 'groq' = 'whispercpp';
  let transcribeModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' = 'base';
  // Live elapsed counter while whisper runs. The kernel doesn't ship a
  // streaming progress event for transcribe, so we just animate elapsed-vs-eta
  // — better than a frozen "generating…" label that makes users abandon.
  let transcribeStartedAt = 0;
  let transcribeElapsedMs = 0;
  let transcribeTimer: ReturnType<typeof setInterval> | null = null;
  // Just-finished flash for completion feedback (auto-clears).
  let transcribeJustDone = false;
  let transcribeCueCount = 0;
  // Bound to the playing <video>. Used to (a) auto-enable text tracks once
  // the browser has parsed them and (b) compute a per-engine ETA based on
  // the actual video duration the moment we have it.
  let videoEl: HTMLVideoElement | null = null;

  async function loadTranscribeInfo() {
    if (transcribeInfo) return;
    try {
      const r = await apiFetch('/api/cinema/media/transcribe/info');
      if (r.ok) {
        transcribeInfo = await r.json();
        if (transcribeInfo?.engines.groq.available) transcribeEngine = 'groq';
        else if (transcribeInfo?.engines.whispercpp.available) transcribeEngine = 'whispercpp';
        else transcribeEngine = 'transformers';
      }
    } catch { /* */ }
  }

  // Build the URL for the auto-generated VTT track (same shape as
  // translate-srt; cached on the kernel by the same hashing scheme).
  function transcribeUrl(): string {
    if (!playItem || !playFiles[playActiveIdx]) return '';
    const file = playFiles[playActiveIdx];
    const upstream = archiveDownloadUrl(playItem.identifier, file.name);
    const params = new URLSearchParams({ url: upstream, engine: transcribeEngine, model: transcribeModel });
    if (subSourceLang) params.set('lang', subSourceLang);
    if (subsJobId) params.set('jobId', subsJobId);
    return `/api/cinema/media/transcribe?${params.toString()}`;
  }

  // AbortController for the in-flight whisper fetch, exposed so the
  // overlay's Cancel button can interrupt a runaway job.
  let transcribeAbort: AbortController | null = null;
  // Hard ceiling so a stuck whisper run doesn't pin the overlay
  // forever. 25 min covers a feature film on whisper.cpp · base; bigger
  // models or transformers engine may need more.
  const TRANSCRIBE_HARD_TIMEOUT_MS = 25 * 60 * 1000;

  function cancelGenerateSubs(): void {
    // Abort BOTH the legacy generateSubs() path AND the unified-flow
    // loadTranscriptManual() fetch — the user clicks one Cancel and
    // expects everything to stop, regardless of which path is running.
    if (transcribeAbort) {
      console.log('[cinema] cancelGenerateSubs: aborting transcribeAbort');
      try { transcribeAbort.abort(); } catch { /* */ }
      transcribeAbort = null;
    }
    if (inflightAbort) {
      console.log('[cinema] cancelGenerateSubs: aborting inflightAbort');
      try { inflightAbort.abort(); } catch { /* */ }
      inflightAbort = null;
      inflightTrackUrl = '';
    }
    transcribeBusy = false;
    translateBusy = false;
    if (transcribeTimer) { clearInterval(transcribeTimer); transcribeTimer = null; }
    if (translateTimer) { clearInterval(translateTimer); translateTimer = null; }
    if (modalPhaseSwapTimer) { clearTimeout(modalPhaseSwapTimer); modalPhaseSwapTimer = null; }
    stopSubsProgressStream();
    transcribeError = 'Cancelled by user.';
    subsApplied = false;          // user cancelled — let them re-configure
  }

  async function generateSubs() {
    if (transcribeBusy || !playItem || !playFiles[playActiveIdx]) return;
    console.log('[cinema] generateSubs: starting whisper', transcribeEngine, transcribeModel);
    transcribeBusy = true;
    transcribeError = '';
    transcribeStartedAt = Date.now();
    transcribeElapsedMs = 0;
    // Open the SSE so the bar tracks whisper.cpp's per-percent progress.
    // Must happen BEFORE transcribeUrl() is called so the jobId lands in
    // the request query.
    if (!subsJobId) startSubsProgressStream();
    if (transcribeTimer) clearInterval(transcribeTimer);
    transcribeTimer = setInterval(() => {
      transcribeElapsedMs = Date.now() - transcribeStartedAt;
    }, 250);
    transcribeAbort = new AbortController();
    const timeoutHandle = setTimeout(() => {
      console.warn('[cinema] generateSubs: hard timeout after', TRANSCRIBE_HARD_TIMEOUT_MS, 'ms');
      try { transcribeAbort?.abort(); } catch { /* */ }
      transcribeError = `Whisper timed out after ${Math.round(TRANSCRIBE_HARD_TIMEOUT_MS / 60000)} min — try a smaller model or a faster engine.`;
    }, TRANSCRIBE_HARD_TIMEOUT_MS);

    try {
      const r = await apiFetch(transcribeUrl(), {
        method: 'GET',
        signal: transcribeAbort.signal,
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        transcribeError = e.error ?? `http ${r.status}`;
        console.warn('[cinema] generateSubs: kernel returned', r.status, transcribeError);
        return;
      }
      const cueHdr = r.headers.get('x-transcribe-cues');
      transcribeCueCount = cueHdr ? parseInt(cueHdr, 10) : 0;
      await r.text();           // drain so the cache file lands on disk
      console.log('[cinema] generateSubs: success', transcribeCueCount, 'cues in', Date.now() - transcribeStartedAt, 'ms');
      transcribeAvailable = true;
      subSource = 'auto';
      transcribeJustDone = true;
      setTimeout(() => { transcribeJustDone = false; }, 4500);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.log('[cinema] generateSubs: aborted (cancel or timeout)');
        // transcribeError already set by the cancel/timeout path
      } else {
        transcribeError = err?.message ?? String(err);
        console.warn('[cinema] generateSubs: failed', transcribeError);
      }
    } finally {
      clearTimeout(timeoutHandle);
      transcribeAbort = null;
      transcribeBusy = false;
      if (transcribeTimer) { clearInterval(transcribeTimer); transcribeTimer = null; }
      stopSubsProgressStream();
      console.log('[cinema] generateSubs: finally → transcribeBusy=false');
    }
  }

  // Per-engine throughput estimates (audio-seconds processed per wall-second).
  // Calibrated from the local box: whisper.cpp `base` does ~30x realtime,
  // `transformers` ~5x, groq cloud ~180x. Tweak if you upgrade hardware.
  function estimateEtaMs(): number | null {
    const dur = videoEl?.duration;
    if (!dur || !Number.isFinite(dur)) return null;
    const xRealtime: Record<string, Record<string, number>> = {
      whispercpp:   { tiny: 60, base: 30, small: 15, medium: 6,  'large-v3': 3 },
      transformers: { tiny: 12, base: 5,  small: 2.5, medium: 1.2, 'large-v3': 0.6 },
      groq:         { tiny: 180, base: 180, small: 180, medium: 180, 'large-v3': 180 },
    };
    const factor = xRealtime[transcribeEngine]?.[transcribeModel] ?? 5;
    return (dur / factor) * 1000;
  }

  function fmtElapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60), ss = s % 60;
    return m > 0 ? `${m}:${String(ss).padStart(2, '0')}` : `${ss}s`;
  }
  /** Format audio seconds as "5m24s" / "12s" / "1h03m". Smaller than
   *  fmtElapsed because it can hit movie-length values. */
  function fmtAudio(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), ss = s % 60;
    if (m < 60) return ss === 0 ? `${m}m` : `${m}m${String(ss).padStart(2, '0')}s`;
    const h = Math.floor(m / 60), mm = m % 60;
    return `${h}h${String(mm).padStart(2, '0')}m`;
  }
  /** Per-phase title shown in the transcribe modal. The default ("Preparing
   *  transcription…") is reserved for the brief startup window before any
   *  SSE event has arrived. If we already have audio data flowing but the
   *  subPhase event hasn't landed yet, infer from `transcribeFrac` /
   *  `transcribeProcessedSec` so the title doesn't lie. */
  function transcribePhaseTitle(): string {
    switch (transcribeSubPhase) {
      case 'probe':       return 'Probing audio…';
      case 'load-model':  return 'Downloading whisper model…';
      case 'extract':     return 'Downloading & decoding audio…';
      case 'transcribe':  return 'Transcribing audio…';
    }
    if (transcribeFrac > 0 || transcribeProcessedSec > 0) return 'Transcribing audio…';
    return 'Preparing transcription…';
  }

  // Probe the kernel for a cached VTT for the (url, engine, model, lang)
  // combo currently selected. Sets `transcribeAvailable` so the UI swaps
  // the "generate" button for the "auto" toggle without an extra click.
  // Also stashes whether ANY engine/model has produced a cache for this
  // URL — lets us hint "we have one with whisper.cpp/base, switch?".
  let transcribeCacheAny = false;     // true if some combo is cached
  async function probeTranscribeCache(): Promise<void> {
    if (!playItem || !playFiles[playActiveIdx]) {
      transcribeAvailable = false;
      transcribeCacheAny = false;
      return;
    }
    const file = playFiles[playActiveIdx];
    const upstream = archiveDownloadUrl(playItem.identifier, file.name);
    const params = new URLSearchParams({ url: upstream, engine: transcribeEngine, model: transcribeModel });
    if (subSourceLang) params.set('lang', subSourceLang);
    try {
      const r = await apiFetch(`/api/cinema/media/transcribe/cached?${params.toString()}`);
      if (!r.ok) return;
      const data = await r.json() as { exact: boolean; any: boolean; key: string };
      transcribeAvailable = data.exact;
      transcribeCacheAny = data.any;
    } catch { /* ignore — keep the generate button visible */ }
  }
  // Re-probe whenever the player opens, the file list arrives, the active
  // file changes, or the user fiddles with engine/model/lang. `playFiles`
  // MUST be in the dep list — without it the probe runs once on `playOpen`
  // (when the list is still empty), early-returns with transcribeAvailable
  // = false, and never re-checks once files load. Cheap GET, no harm in
  // re-firing.
  $: if (typeof window !== 'undefined' && playOpen && playItem) {
    void playFiles; void playActiveIdx;
    void transcribeEngine; void transcribeModel; void subSourceLang;
    probeTranscribeCache();
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
  $: if (typeof window !== 'undefined' && playOpen && !playLoading && subSource === 'off') {
    if (transcribeAvailable) {
      console.log('[cinema] auto-enabling cached transcribed subs');
      subSource = 'auto';
    } else if (hasSrt) {
      console.log('[cinema] auto-enabling shipped SRT subs');
      subSource = 'orig';
    }
  }

  // (legacy reactive removed — apply flow now driven by the single CTA
  //  + subsApplied gate. See applySubs() above.)

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
  let settingsOpen = false;
  let settingsTab: 'subs' | 'style' | 'speed' = 'subs';
  let activeCueText = '';           // current cue(s) the overlay paints
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

  // Programmatic VTT loader — Svelte's `{#if trackUrl} <track>` inside
  // `<video>` doesn't always register the track on the media element
  // (the if-block comment markers confuse the browser). We fetch the VTT
  // ourselves, parse it, and feed cues into a TextTrack created via
  // `addTextTrack()`. Same end-result, no <track> element needed.
  let manualTrack: TextTrack | null = null;
  let lastLoadedTrackUrl = '';
  let inflightTrackUrl = '';      // dedupe: which URL is being fetched right now
  let inflightAbort: AbortController | null = null;  // cancel old fetch on new one

  // Translate-in-progress UX. The kernel's `/api/cinema/media/translate-srt`
  // endpoint is synchronous and can take 4–5 min on NLLB (CPU). Without a
  // visible status the user thinks the click did nothing.
  let translateBusy = false;
  let translateStartedAt = 0;
  let translateElapsedMs = 0;
  let translateTimer: ReturnType<typeof setInterval> | null = null;
  let translateError = '';
  let translateMode: 'transcribe' | 'translate' = 'translate';

  // Real-time subs-pipeline progress fed by the kernel via SSE
  // (`/api/cinema/media/subs/progress?jobId=…`). Covers BOTH phases —
  // transcribe (`frac` from whisper.cpp's per-percent stdout) and
  // translate (`cuesDone/cuesTotal` per-batch). When real data is
  // available the bar tracks it instead of the wall-clock estimate.
  let subsJobId = '';
  let translateCuesDone = 0;
  let translateCuesTotal = 0;
  let translateEtaMs = 0;       // 0 = no kernel data yet (fall back to estimate)
  let transcribeFrac = 0;       // 0–1 from kernel; 0 = no kernel data
  // Sub-phase tracking — populated by the kernel's `transcribe-progress`
  // event so the modal can show "Downloading model… (40 MB)" vs
  // "Transcribing… 47% (2m18s of 5m23s)". When `transcribeSubPhase` is
  // empty the bar runs in indeterminate mode (animated stripes, no %).
  let transcribeSubPhase: '' | 'probe' | 'load-model' | 'extract' | 'transcribe' = '';
  let transcribeProcessedSec = 0;
  let transcribeTotalSec = 0;
  let transcribeHint = '';
  let subsSse: EventSource | null = null;

  function startSubsProgressStream(): string {
    if (subsSse) { try { subsSse.close(); } catch { /* */ } subsSse = null; }
    translateCuesDone = 0;
    translateCuesTotal = 0;
    translateEtaMs = 0;
    transcribeFrac = 0;
    transcribeSubPhase = '';
    transcribeProcessedSec = 0;
    transcribeTotalSec = 0;
    transcribeHint = '';
    const jobId = crypto.randomUUID();
    subsJobId = jobId;
    const token = (typeof window !== 'undefined' ? localStorage.getItem('kernel_auth_token') : null) ?? '';
    // EventSource can't set headers — the kernel accepts the auth token as
    // a `?auth=` query parameter (src/core/auth.ts).
    const authPart = token ? `&auth=${encodeURIComponent(token)}` : '';
    const sseUrl = `/api/cinema/media/subs/progress?jobId=${encodeURIComponent(jobId)}${authPart}`;
    try {
      subsSse = new EventSource(sseUrl);
      subsSse.onmessage = (ev) => {
        if (!ev.data) return;
        try {
          const d = JSON.parse(ev.data) as
            // transcribe phase
            | { phase: 'transcribe-start'; engine?: string; model?: string; lang?: string }
            | {
                phase: 'transcribe-progress';
                frac?: number;
                subPhase?: 'probe' | 'load-model' | 'extract' | 'transcribe';
                processedSec?: number;
                totalSec?: number;
                hint?: string;
              }
            | { phase: 'transcribe-done'; cueCount?: number; elapsedMs?: number }
            | { phase: 'transcribe-error'; error?: string }
            // translate phase
            | { phase: 'start'; cuesTotal?: number }
            | { phase: 'progress'; cuesDone?: number; cuesTotal?: number; etaMs?: number; elapsedMs?: number }
            | { phase: 'done' }
            | { phase: 'error'; error?: string };
          if (d.phase === 'transcribe-start') {
            transcribeFrac = 0;
            transcribeSubPhase = '';
            transcribeProcessedSec = 0;
            transcribeTotalSec = 0;
            transcribeHint = '';
          } else if (d.phase === 'transcribe-progress') {
            if (typeof d.frac === 'number') transcribeFrac = Math.max(0, Math.min(1, d.frac));
            if (d.subPhase) transcribeSubPhase = d.subPhase;
            if (typeof d.processedSec === 'number') transcribeProcessedSec = d.processedSec;
            if (typeof d.totalSec === 'number') transcribeTotalSec = d.totalSec;
            if (typeof d.hint === 'string') transcribeHint = d.hint;
          } else if (d.phase === 'transcribe-done') {
            transcribeFrac = 1;
            transcribeSubPhase = 'transcribe';
            if (typeof d.cueCount === 'number') transcribeCueCount = d.cueCount;
          } else if (d.phase === 'start') {
            translateCuesTotal = d.cuesTotal ?? 0;
            translateCuesDone = 0;
          } else if (d.phase === 'progress') {
            if (typeof d.cuesTotal === 'number') translateCuesTotal = d.cuesTotal;
            if (typeof d.cuesDone === 'number') translateCuesDone = d.cuesDone;
            if (typeof d.etaMs === 'number') translateEtaMs = d.etaMs;
          }
          // 'done' / 'error' are surfaced through the HTTP response of the
          // pipeline fetch itself; we just keep the SSE open until then.
        } catch { /* ignore malformed event */ }
      };
      subsSse.onerror = () => {
        // EventSource auto-reconnects; nothing to do.
      };
    } catch { /* SSE not supported / blocked — fall through, bar uses estimate */ }
    return jobId;
  }

  function stopSubsProgressStream(): void {
    if (subsSse) { try { subsSse.close(); } catch { /* */ } subsSse = null; }
    subsJobId = '';
  }

  function startProgress(mode: 'transcribe' | 'translate'): void {
    // Idempotent: if the same mode is already running, don't reset the
    // elapsed counter (applySubs() and the lazy timer in
    // loadTranscriptManual() may both trigger it for the same fetch).
    if (mode === 'transcribe' && transcribeBusy) return;
    if (mode === 'translate' && translateBusy) return;
    translateMode = mode;
    translateError = '';
    if (mode === 'transcribe') {
      // Route to the BIG centered transcribe-overlay modal (with spinner,
      // ETA bar, Cancel) — this is the "modal bonito" the user expects to
      // see whenever whisper is running, regardless of whether it was
      // triggered by the legacy generateSubs() path or the unified
      // applySubs() → loadTranscriptManual() pipeline.
      transcribeBusy = true;
      transcribeError = '';
      transcribeStartedAt = Date.now();
      transcribeElapsedMs = 0;
      if (transcribeTimer) clearInterval(transcribeTimer);
      transcribeTimer = setInterval(() => {
        transcribeElapsedMs = Date.now() - transcribeStartedAt;
      }, 250);
    } else {
      // Smaller corner translate-card — translation can run in parallel
      // with the user already watching the original-lang subs.
      translateBusy = true;
      translateStartedAt = Date.now();
      translateElapsedMs = 0;
      if (translateTimer) clearInterval(translateTimer);
      translateTimer = setInterval(() => {
        translateElapsedMs = Date.now() - translateStartedAt;
      }, 250);
    }
    // Open the SSE channel ONCE per pipeline run — covers both transcribe
    // and translate phases, so a unified runAutoTranslatePipeline doesn't
    // need to re-open it on the phase swap (which would race the kernel's
    // first batch event). Reuse if it's already open.
    if (!subsJobId) startSubsProgressStream();
  }
  function stopProgress(err?: string): void {
    // Clear both: a single pipeline run may have started transcribe first
    // and translate after, so we don't know which is currently active.
    translateBusy = false;
    transcribeBusy = false;
    if (translateTimer) { clearInterval(translateTimer); translateTimer = null; }
    if (transcribeTimer) { clearInterval(transcribeTimer); transcribeTimer = null; }
    if (modalPhaseSwapTimer) { clearTimeout(modalPhaseSwapTimer); modalPhaseSwapTimer = null; }
    stopSubsProgressStream();
    if (err) {
      // Surface the error in whichever card is/was showing.
      if (translateMode === 'transcribe') transcribeError = err;
      else translateError = err;
    }
  }
  // Rough ETA: nllb is ~0.3-0.4s/cue on CPU, grok is ~0.05s/cue (one batch).
  // We don't know cue count up front, so we estimate from video duration:
  // assume ~10 cues/min of audio for a typical talking video.
  function estimateTranslateMs(): number | null {
    const dur = videoEl?.duration;
    if (!dur || !Number.isFinite(dur)) return null;
    const estCues = Math.max(50, dur / 6);     // ~10 cues per minute
    // LLM chain (cloud or local GPU): ~50ms per cue. NLLB (offline CPU): ~400ms.
    const perCue = subEngine === 'llm' ? 0.05 : 0.4;
    return estCues * perCue * 1000;
  }

  function parseVttTimestamp(ts: string): number {
    const parts = ts.split(':');
    if (parts.length === 3) return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
    return +parts[0] * 60 + parseFloat(parts[1]);
  }

  function parseVtt(raw: string): Array<{ start: number; end: number; text: string }> {
    const out: Array<{ start: number; end: number; text: string }> = [];
    const lines = raw.replace(/\r/g, '').split('\n');
    let i = 0;
    // Skip WEBVTT header + any NOTE blocks until first cue.
    while (i < lines.length && !lines[i].includes('-->')) i++;
    while (i < lines.length) {
      const m = lines[i].match(/(\d+(?::\d+){1,2}(?:\.\d+)?)\s*-->\s*(\d+(?::\d+){1,2}(?:\.\d+)?)/);
      if (!m) { i++; continue; }
      const start = parseVttTimestamp(m[1]);
      const end = parseVttTimestamp(m[2]);
      i++;
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        buf.push(lines[i]);
        i++;
      }
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        out.push({ start, end, text: buf.join('\n') });
      }
      while (i < lines.length && lines[i].trim() === '') i++;
    }
    return out;
  }

  // Trigger transcript load. Called from multiple places (reactive,
  // on:loadedmetadata, onPlayState) because Svelte's bind:this+$:
  // combination can miss the moment when `videoEl` finally has a value.
  function maybeLoadTranscript(): void {
    if (typeof window === 'undefined') return;
    // CRITICAL: compute the track URL fresh inside the function instead of
    // reading the `$: trackUrl` reactive var. Svelte's topological sort
    // is based on real reads (not `void`s), so `trackUrl` may be stale
    // when this reactive block fires earlier than the trackUrl one.
    const url = trackSrc();
    console.log('[cinema] maybeLoadTranscript', { hasVideo: !!videoEl, url, subTrack, transcribeAvailable, hasPlayItem: !!playItem, filesLen: playFiles.length, lastLoadedTrackUrl });
    if (!videoEl) { return; }
    if (!url) {
      // Only WIPE cues when the user explicitly turned subs OFF. trackSrc()
      // also returns '' for "auto, not yet generated" — in that state a
      // cached transcript may already be installed by selectCachedSub(), and
      // clearing it here would erase subs the user is watching.
      if (subSource === 'off') {
        if (manualTrack) {
          while (manualTrack.cues && manualTrack.cues.length > 0) {
            manualTrack.removeCue(manualTrack.cues[0]);
          }
        }
        activeCueText = '';
        lastLoadedTrackUrl = '';
      }
      return;
    }
    if (url === lastLoadedTrackUrl) { console.log('[cinema] maybeLoadTranscript: already loaded, skip'); return; }
    if (url === inflightTrackUrl) { console.log('[cinema] maybeLoadTranscript: in-flight, skip'); return; }
    void loadTranscriptManual(url);
  }
  // Reactive: re-fire when ANY input that affects trackSrc() or videoEl
  // changes. We list all deps as real reads (no void) so Svelte tracks
  // them properly and the reactive block ends up AFTER trackSrc()'s deps
  // in topological order.
  $: {
    if (videoEl || subTrack || playItem || transcribeAvailable
        || transcribeEngine || transcribeModel || subEngine
        || subTargetLang || subSourceLang || playFiles || playActiveIdx
        || generateRequested) {
      maybeLoadTranscript();
    }
  }

  async function loadTranscriptManual(url: string): Promise<void> {
    const v = videoEl;
    if (!v) return;
    console.log('[cinema] fetching VTT:', url);
    // Cancel any prior in-flight fetch so we don't end up with two
    // overlapping requests competing to set translateBusy / call
    // stopProgress in the wrong order. The aborted call's catch handler
    // recognises AbortError and exits without touching state.
    if (inflightAbort) { try { inflightAbort.abort(); } catch { /* */ } }
    inflightAbort = new AbortController();
    const myAbort = inflightAbort;
    inflightTrackUrl = url;
    // Detect long-running kernel work: translate-srt is slow (NLLB CPU
    // inference) and transcribe (cache miss) is even slower. Show a
    // progress card during the wait so the user has feedback.
    // The unified `/api/cinema/media/subs` endpoint runs transcribe (always) +
    // translate (if `tgt` is set) inside a single kernel call — show the
    // big centered transcribe modal because that's the dominant cost.
    const isUnified = url.startsWith('/api/cinema/media/subs');
    const isTranslate = url.startsWith('/api/cinema/media/translate-srt');
    const isTranscribe = url.startsWith('/api/cinema/media/transcribe') || isUnified;
    // Closure-scoped lazy timer for transcribe — previously stored on
    // globalThis, which the second concurrent call would overwrite,
    // leaking the first timer (it would fire later and stick the
    // "Loading transcript…" card on screen forever).
    let lazyTimer: ReturnType<typeof setTimeout> | null = null;
    // CRITICAL: applySubs() now starts progress optimistically AND may
    // schedule a transcribe→translate phase swap. Re-starting it from
    // here would race the swap timer and resurrect transcribe mode after
    // we already moved on, leaving BOTH the big modal AND the corner
    // card visible at once. Only engage if nothing's already showing.
    if (isTranslate && !translateBusy && !transcribeBusy) {
      startProgress('translate');
    } else if (isTranscribe && !translateBusy && !transcribeBusy) {
      // Cache hits return in <100ms — only show progress if the response
      // genuinely delays beyond 1.5s. Re-check at fire time too.
      lazyTimer = setTimeout(() => {
        if (!translateBusy && !transcribeBusy) startProgress('transcribe');
      }, 1500);
    }
    // Open SSE eagerly so jobId is ready to forward in the request below,
    // regardless of whether the modal overlay shows lazily. The kernel
    // publishes progress for /transcribe, /translate-srt, and /subs.
    if (!subsJobId && (isTranslate || isTranscribe)) {
      startSubsProgressStream();
    }
    let fetchUrl = url;
    if (subsJobId && (isTranslate || isTranscribe) && !fetchUrl.includes('jobId=')) {
      const sep = fetchUrl.includes('?') ? '&' : '?';
      fetchUrl = `${fetchUrl}${sep}jobId=${encodeURIComponent(subsJobId)}`;
    }
    let raw: string;
    try {
      const r = await apiFetch(fetchUrl, { credentials: 'omit', signal: myAbort.signal });
      if (lazyTimer) { clearTimeout(lazyTimer); lazyTimer = null; }
      if (!r.ok) {
        let msg = `http ${r.status}`;
        try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* fall through */ }
        throw new Error(msg);
      }
      raw = await r.text();
    } catch (err) {
      // If we got aborted because a newer fetch superseded us, exit
      // silently — the new fetch's lifecycle owns the progress state.
      if (err instanceof Error && err.name === 'AbortError') {
        console.log('[cinema] VTT fetch aborted (superseded):', url.slice(-80));
        if (lazyTimer) clearTimeout(lazyTimer);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[cinema] VTT fetch failed:', msg);
      if (lazyTimer) clearTimeout(lazyTimer);
      stopProgress(msg);
      if (inflightTrackUrl === url) inflightTrackUrl = '';
      if (inflightAbort === myAbort) inflightAbort = null;
      return;
    }
    stopProgress();
    if (inflightTrackUrl === url) inflightTrackUrl = '';
    if (inflightAbort === myAbort) inflightAbort = null;
    if (parseVttShared(raw).length === 0) {
      console.warn('[cinema] loadTranscriptManual: 0 cues — VTT may be malformed');
      return;
    }
    lastLoadedTrackUrl = url;
    // One owner for display: hand the body to the shared controller instead of
    // driving a second TextTrack from here.
    if (!subsCtl) subsCtl = new SubsController(cinemaAdapter(), () => { subsTick++; });
    subsCtl.setVideo(v);
    subsCtl.showVtt(raw, { lang: subSourceLang || 'en' });
    subsTick++;
    refreshCachedSubs().then(() => ensureCurrentSubInCacheList());
    resumePlaybackIfArmed();          // auto-resume from 0:00 with subs ready
    console.log(`[cinema] manual track ready, mode=${manualTrack.mode}, cues=${manualTrack.cues?.length}`);
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
  function onVolumeInput(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (!videoEl) return;
    videoEl.volume = parseFloat(input.value);
    videoEl.muted = videoEl.volume === 0;
  }
  function toggleFullscreen(): void {
    // The fullscreen target is the .video-stack so the captions overlay
    // and custom controls go fullscreen WITH the video. If we requested
    // it on the bare <video>, the browser's UA stylesheet would replace
    // our chrome with the native one.
    const target = videoEl?.parentElement;
    if (!target) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void target.requestFullscreen?.();
    }
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
      const r = await apiFetch(`/api/cinema/media/probe?url=${encodeURIComponent(upstream)}`);
      if (!r.ok || myToken !== probedDurationToken) return;
      const j = await r.json();
      if (myToken !== probedDurationToken) return;
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
  function onLoadedMeta(): void {
    onDurationChange();
    enableAllTextTracks();
    // Last-resort trigger: if the reactive `$: maybeLoadTranscript()`
    // missed the videoEl-becomes-available moment, this catches it.
    maybeLoadTranscript();
  }

  // Auto-hide controls after 2.5s of no mouse activity during playback.
  // Always visible while paused, while settings open, or on hover.
  function showControls(): void {
    controlsVisible = true;
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
    controlsHideTimer = setTimeout(() => {
      if (playerIsPlaying && !settingsOpen) controlsVisible = false;
    }, 2500);
  }

  function fmtTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const t = Math.floor(s);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = t % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
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
    subsCtl?.setVideo(videoEl);
  }

  $: if (typeof window !== 'undefined' && trackUrl) {
    setTimeout(enableAllTextTracks, 120);
  }

  // The first .srt file in the playFiles list (archive.org typically ships
  // English subs only for these old films).
  function findSrtFile(files: PlayFile[]): PlayFile | null {
    return files.find(f => /\.srt$/i.test(f.name)) ?? null;
  }
  function srtUpstreamUrl(item: ArchiveItem, srt: PlayFile): string {
    return archiveDownloadUrl(item.identifier, srt.name);
  }

  // ── Shipped-subtitle detection ────────────────────────────────────
  // archive.org items often ship one or more sub files alongside the
  // video (English.srt, movie.es.srt, foo.fr.vtt, subtitles.it.ass …).
  // We scan playFiles, derive the language from filename conventions,
  // and surface each as a synthetic cachedSub so the user can:
  //  (a) pick it directly from SELECT (instant — no whisper needed)
  //  (b) translate it to a different lang via /translate-srt (no whisper)
  // Recognized patterns (case-insensitive):
  //   foo.es.srt           → es
  //   foo-spanish.vtt      → es (matched against ISO+name table)
  //   spanish.srt          → es
  //   subtitulos.es.srt    → es
  //   foo.srt              → unknown (assumed = subSourceLang for fallback)
  interface ShippedSub { file: PlayFile; lang: string; key: string; }
  function detectShippedSubs(files: PlayFile[]): ShippedSub[] {
    const subs: ShippedSub[] = [];
    for (const f of files) {
      if (!/\.(srt|vtt|ass|ssa|sub)$/i.test(f.name)) continue;
      const lang = sniffLangFromFilename(f.name);
      subs.push({
        file: f,
        lang,
        key: `shipped:${f.name}`,
      });
    }
    return subs;
  }
  // Map common language names/aliases to ISO 639-1 codes. Covers the
  // patterns archive.org rippers use most often (English, English_US,
  // spanish, español, latin, dub-en, etc.).
  function sniffLangFromFilename(name: string): string {
    const stem = name.toLowerCase().replace(/\.(srt|vtt|ass|ssa|sub)$/i, '');
    // Pattern 1: extension-style code suffix `.xx`  (e.g. movie.es.srt)
    const m1 = stem.match(/\.([a-z]{2,3})(?:[._-]|$)/);
    if (m1 && ISO_LANGS.has(m1[1])) return m1[1];
    // Pattern 2: language NAME anywhere in the filename
    for (const [needle, iso] of LANG_ALIASES) {
      if (stem.includes(needle)) return iso;
    }
    return '';            // unknown — caller treats as source language
  }
  const ISO_LANGS = new Set([
    'en','es','pt','fr','de','it','ja','zh','ru','ko','ar','nl','sv','no','da','fi','pl','tr','el','he','hi','th','vi','id','cs','ro','hu','uk','bg',
  ]);
  const LANG_ALIASES: Array<[string, string]> = [
    ['english', 'en'], ['eng', 'en'], ['inglés', 'en'], ['ingles', 'en'],
    ['spanish', 'es'], ['español', 'es'], ['espanol', 'es'], ['castellano', 'es'], ['latino', 'es'], ['esp', 'es'],
    ['portuguese', 'pt'], ['português', 'pt'], ['portugues', 'pt'], ['brasileiro', 'pt'], ['ptbr', 'pt'], ['pt-br', 'pt'],
    ['french', 'fr'], ['français', 'fr'], ['francais', 'fr'],
    ['german', 'de'], ['deutsch', 'de'], ['aleman', 'de'], ['alemán', 'de'],
    ['italian', 'it'], ['italiano', 'it'],
    ['japanese', 'ja'], ['日本語', 'ja'],
    ['chinese', 'zh'], ['mandarin', 'zh'], ['中文', 'zh'],
    ['russian', 'ru'], ['русский', 'ru'],
    ['korean', 'ko'], ['한국어', 'ko'],
    ['arabic', 'ar'], ['عربي', 'ar'],
    ['dutch', 'nl'], ['nederlands', 'nl'],
    ['swedish', 'sv'], ['svenska', 'sv'],
    ['polish', 'pl'], ['polski', 'pl'],
    ['turkish', 'tr'], ['türkçe', 'tr'],
  ];
  // Build the URL the player should fetch for the currently-applied
  // subtitle config. Single source of truth — gated by `subsApplied`.
  // Routes through the unified /api/cinema/media/subs endpoint for the
  // auto-generate path so transcribe + translate happen in one kernel
  // call (with cache reuse), and through /translate-srt for the
  // shipped-.srt path (which already does what we need).
  function trackSrc(): string {
    if (!playItem || subSource === 'off') return '';
    if (!subsApplied) return '';

    const file = playFiles[playActiveIdx];
    if (!file) return '';
    const willTranslate = translateActive && subTargetLang !== subSourceLang;

    if (subSource === 'auto') {
      // The `/subs` pipeline RUNS WHISPER on cache-miss (model download +
      // full-film transcription). Only hit it after an explicit generate
      // click. On auto-open, a cached transcript is installed directly by
      // selectCachedSub(), so returning '' here just means "cues already in
      // place, don't fetch" — maybeLoadTranscript() won't clear them (it
      // only clears when subSource === 'off').
      if (!generateRequested) return '';
      // Unified pipeline: kernel handles transcribe + (optional) translate
      // with cache at every stage. Single round-trip from the browser.
      const upstream = archiveDownloadUrl(playItem.identifier, file.name);
      const params = new URLSearchParams({
        url: upstream,
        lang: subSourceLang,
        transcribe_engine: transcribeEngine,
        transcribe_model: transcribeModel,
      });
      if (willTranslate) {
        params.set('tgt', subTargetLang);
        params.set('translate_engine', subEngine);
      }
      return `/api/cinema/media/subs?${params.toString()}`;
    }

    // subSource === 'orig' → shipped .srt, optionally translated.
    const srt = findSrtFile(playFiles);
    if (!srt) return '';
    const upstream = srtUpstreamUrl(playItem, srt);
    const params = new URLSearchParams({ url: upstream, src: subSourceLang });
    if (willTranslate) {
      params.set('tgt', subTargetLang);
      params.set('engine', subEngine);
    } else {
      params.set('passthrough', '1');
      params.set('tgt', subSourceLang);
    }
    return `/api/cinema/media/translate-srt?${params.toString()}`;
  }
  $: trackUrl = (() => {
    // Recompute when any of these change. Listed explicitly so Svelte picks
    // them up as dependencies.
    void subTrack; void subEngine; void subTargetLang; void subSourceLang;
    void playItem; void playFiles; void playActiveIdx;
    void transcribeAvailable; void transcribeEngine; void transcribeModel;
    void generateRequested;
    return trackSrc();
  })();
  $: hasSrt = playFiles.some(f => /\.srt$/i.test(f.name));

  const TRANSCODABLE = ['mpg', 'mpeg', 'm2v', 'avi', 'wmv', 'flv', 'rm', 'rmvb', 'asf', 'vob'];
  function fileKind(name: string): string {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'].includes(ext)) return 'video';
    if (TRANSCODABLE.includes(ext)) return 'video';
    if (['mp3', 'flac', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return 'image';
    if (['txt', 'md', 'log', 'json', 'csv', 'xml', 'srt', 'vtt', 'yaml', 'yml'].includes(ext)) return 'text';
    return 'other';
  }
  // Display order in the modal file list: videos always first, then audio,
  // images, text, anything else last.
  const KIND_ORDER: Record<string, number> = {
    video: 0, audio: 1, image: 2, text: 3, other: 4,
  };
  function pickDefaultPlayIdx(files: PlayFile[]): number {
    // Prefer mp4 > webm > mov > mkv > ogv > mpg/avi (transcoded) > audio
    const order = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'mpg', 'mpeg', 'avi', 'm2v', 'mp3', 'flac', 'ogg', 'opus'];
    for (const ext of order) {
      const idx = files.findIndex(f => f.name.toLowerCase().endsWith('.' + ext));
      if (idx >= 0) return idx;
    }
    return 0;
  }
  // archive.org needs literal "/" between subdirectories (Alf/Specials/...).
  // encodeURIComponent on a whole file path turns those into %2F and the
  // upstream silently 404s / hangs ffprobe. Encode segment-by-segment so
  // spaces and unicode are escaped but separators stay intact.
  function archiveDownloadUrl(identifier: string, filename: string): string {
    const encodedFile = filename.split('/').map(encodeURIComponent).join('/');
    return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodedFile}`;
  }
  // `<video src=…>` bypasses our global fetch interceptor, so the browser
  // can't add an Authorization header. The kernel accepts `?auth=<token>`
  // as a query-string fallback for exactly this case (src/core/auth.ts).
  function authQuery(): string {
    if (typeof window === 'undefined') return '';
    const t = localStorage.getItem('kernel_auth_token');
    return t ? `&auth=${encodeURIComponent(t)}` : '';
  }
  function buildPlayUrl(item: ArchiveItem, file: PlayFile, forceTranscode = false): { src: string; needsTranscode: boolean } {
    const upstream = archiveDownloadUrl(item.identifier, file.name);
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    const needsTranscode = forceTranscode || TRANSCODABLE.includes(ext);
    const origin = (typeof window !== 'undefined' ? window.location.origin : '');
    const endpoint = needsTranscode ? '/api/cinema/media/transcode' : '/api/cinema/media/webseed-proxy';
    return { src: `${origin}${endpoint}?url=${encodeURIComponent(upstream)}${authQuery()}`, needsTranscode };
  }

  // Watchdog for "MP4 plays but black screen" (codec inside the container
  // not browser-supported — common with archive.org rips that use H.265,
  // MPEG4 Part 2, DivX, or pixel formats like yuv422p10le). After
  // loadedmetadata fires we check `videoWidth`; if it's 0, the decoder
  // didn't take. Same goes for `<video on:error>`. Either path triggers
  // an auto-fallback to /api/cinema/media/transcode so ffmpeg re-mux/re-
  // encodes to a profile every browser eats.
  let codecFallbackUsed = false;        // avoid infinite loop
  let codecFallbackHint = '';            // banner message
  let videoLoadWatchdog: ReturnType<typeof setTimeout> | null = null;

  // Manual toggle handler — extracted from the template because inline
  // `as HTMLInputElement` casts inside Svelte attribute expressions
  // trip the parser (TS-in-template restriction).
  function onForceTranscodeToggle(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const force = input.checked;
    if (!playItem || !playFiles[playActiveIdx]) return;
    codecFallbackUsed = force;       // prevent re-fallback loop
    codecFallbackHint = '';
    const built = buildPlayUrl(playItem, playFiles[playActiveIdx], force);
    playSrc = built.src;
    playNeedsTranscode = built.needsTranscode;
  }

  function fallbackToTranscode(reason: string): void {
    if (codecFallbackUsed) return;
    if (!playItem || !playFiles[playActiveIdx]) return;
    codecFallbackUsed = true;
    codecFallbackHint = `Codec not supported (${reason}) — switching to live transcode…`;
    console.warn('[cinema] codec fallback:', reason);
    const built = buildPlayUrl(playItem, playFiles[playActiveIdx], true);
    playSrc = built.src;
    playNeedsTranscode = true;
    // Auto-clear the banner once the transcode load fires loadedmetadata.
    setTimeout(() => { codecFallbackHint = ''; }, 6000);
  }
  function onVideoError(e: Event): void {
    if (codecFallbackUsed) return;
    const v = e.currentTarget as HTMLVideoElement;
    const code = v.error?.code;
    const msgs: Record<number, string> = {
      1: 'aborted', 2: 'network', 3: 'decode error', 4: 'src not supported',
    };
    const msg = msgs[code ?? 0] ?? `error ${code}`;
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
    maybeLoadTranscript();
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
    playFiles = [];
    playActiveIdx = 0;
    playSrc = '';
    subSource = 'off';
    translateActive = false;
    subsApplied = false;              // require explicit APPLY click for this video
    generateRequested = false;        // new video → no whisper until an explicit APPLY
    transcribeAvailable = false;
    transcribeError = '';
    translateError = '';
    codecFallbackUsed = false;
    codecFallbackHint = '';
    try {
      const r = await apiFetch(`/api/cinema/media/import-archive/files?id=${encodeURIComponent(item.identifier)}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        playError = e.error ?? `http ${r.status}`;
        return;
      }
      const body = await r.json();
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

      // Probe the kernel for a cached transcript NOW, while we have the
      // active file URL in scope. The reactive `$: probeTranscribeCache()`
      // lower down also fires, but Svelte 4 sometimes elides `void x`
      // dependency tracking and the playFiles-mutation re-run gets dropped
      // — calling explicitly here makes the auto-show deterministic.
      console.log('[cinema] openPlayer: probing for cached transcript');
      await probeTranscribeCache();
      // Also load the full sidecar list so SELECT shows everything
      // already produced for this video.
      await refreshCachedSubs();
      // Cheap read of the federated index — Stage-4b marketplace.
      // Doesn't hit Nostr/archive.org; just SQLite. The user can ask
      // for a fresh sweep with the "search the network" button.
      await loadFederatedSubs(false);
      // ── Auto-recovery ────────────────────────────────────────────
      // refreshCachedSubs() above already merged THREE sources into
      // `cachedSubs`: shipped .srt files in the archive, transcribe/
      // translate VTTs cached on the kernel, and federated subs we
      // already downloaded. We pick the best one and INSTALL IT now via
      // selectCachedSub() — the cache-hit path returns in <100ms so it
      // looks instant. No modal, no whisper, no waiting.
      //
      // Priority (later wins, in this order): transcribe in source lang
      // (acceptable fallback) → shipped in source lang → cached
      // translation matching user's preferred target lang → most
      // recently created sub.
      //
      // We don't auto-download federated subs (network fetch + trust
      // implications) — the user opens the picker and clicks "bajar"
      // for those.
      const localHasSrt = playFiles.some(f => /\.srt$/i.test(f.name));
      const preferredTgt = subTargetLang || subSourceLang;
      const pickAutoSub = (): CachedSub | null => {
        if (cachedSubs.length === 0) return null;
        // 1. Cached translation matching the user's preferred target lang.
        const matchTgt = cachedSubs.find(
          c => c.kind === 'translation' && c.tgt_lang === preferredTgt,
        );
        if (matchTgt) return matchTgt;
        // 2. Shipped sub in the source language.
        const shippedSrc = cachedSubs.find(
          c => c.kind === 'shipped' && (c.src_lang === subSourceLang || !c.src_lang),
        );
        if (shippedSrc) return shippedSrc;
        // 3. Cached transcribe in source lang.
        const transcribeSrc = cachedSubs.find(
          c => c.kind === 'transcribe' && c.src_lang === subSourceLang,
        );
        if (transcribeSrc) return transcribeSrc;
        // 4. Whatever's freshest (already sorted by refreshCachedSubs).
        return cachedSubs[0];
      };
      const auto = pickAutoSub();
      if (auto) {
        console.log('[cinema] openPlayer: auto-recovering', auto.kind, auto.tgt_lang || auto.src_lang, auto.key);
        subsMode = 'select';
        generateOpen = false;
        // Fire-and-forget — selectCachedSub installs the cues + syncs
        // subSource / subTargetLang / subsApplied so the picker
        // highlight matches reality. We don't await it: the player
        // mounts in parallel with the silent cache fetch. `auto: true`
        // so a `local:` (needs-whisper) pick is skipped, not generated.
        void selectCachedSub(auto, true);
      } else if (transcribeAvailable) {
        // /transcribe cache hit for the CURRENT config (different shape
        // than the sidecar list — uses raw transcribe URL). Treat as
        // ready and let the reactive load it.
        console.log('[cinema] openPlayer: /transcribe cache hit → auto subs');
        subsMode = 'select';
        generateOpen = false;
        subSource = 'auto';
        subsApplied = true;
        activeSubKey = 'off';     // no matching sidecar — leave Off until reactive applies
      } else if (localHasSrt) {
        console.log('[cinema] openPlayer: shipped .srt only → enabling orig');
        subsMode = 'select';
        generateOpen = false;
        subSource = 'orig';
        subsApplied = true;
        activeSubKey = 'shipped';
      } else {
        // No subs anywhere — default wizard to generate so the CTA is
        // obvious. User still has to click START.
        console.log('[cinema] openPlayer: no subs found → wizard primed for generate');
        subsMode = 'generate';
        generateOpen = false;
        subSource = 'auto';
        subsApplied = false;
        activeSubKey = 'off';
      }
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
    maybeLoadTranscript();
  }
  function selectPlayFile(idx: number) {
    if (!playItem || !playFiles[idx]) return;
    playActiveIdx = idx;
    codecFallbackUsed = false;
    codecFallbackHint = '';
    subsApplied = false;              // new file → user must reconfirm subs
    generateRequested = false;        // new file → no whisper until explicit APPLY
    const built = buildPlayUrl(playItem, playFiles[idx]);
    playSrc = built.src;
    playNeedsTranscode = built.needsTranscode;
  }
  function closePlayer() {
    playOpen = false;
    playItem = null;
    playFiles = [];
    playSrc = '';
    playError = '';
    descOpen = false;
    probedDurationSec = 0;
    probedDurationToken++;            // cancel any in-flight probe
    subsMode = 'select';              // reset to default for next video
    activeSubKey = 'off';
    cachedSubs = [];
    filesOpen = false;
  }
  function onPlayerKeydown(e: KeyboardEvent) {
    if (!playOpen) return;
    if (e.key === 'Escape') {
      // First Esc closes settings, second closes player.
      if (settingsOpen) { settingsOpen = false; return; }
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
  function fmtBytes(n: number): string {
    if (n > 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + ' GB';
    if (n > 1_000_000) return (n / 1_000_000).toFixed(1) + ' MB';
    if (n > 1_000) return (n / 1_000).toFixed(1) + ' KB';
    return `${n} B`;
  }

  let observer: IntersectionObserver | null = null;
  onMount(async () => {
    // Hot-render from localStorage (instant) then reconcile with server.
    watchlist = loadLocalWatchlist();
    syncWatchlistFromServer();
    loadTopTags();
    refreshEmbedStatus();
    runSearch();
    loadSubInfo();
    loadTranscribeInfo();
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

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', onPlayerKeydown);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
      }
      observer?.disconnect();
      if (controlsHideTimer) clearTimeout(controlsHideTimer);
      subsCtl?.destroy();
    };
  });

  // Re-attach observer when sentinel mounts/unmounts (it disappears in
  // watchlist mode and reappears in search mode).
  $: if (observer && sentinelEl) {
    observer.disconnect();
    observer.observe(sentinelEl);
  }

  function thumbUrl(identifier: string): string {
    return `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
  }

  function onPosterError(e: Event) {
    const img = e.target as HTMLImageElement | null;
    if (img) img.style.opacity = '0.05';
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
    params.set('limit', String(rows));
    params.set('offset', String((targetPage - 1) * rows));
    params.set('sort', sortMode);
    const r = await apiFetch(`/api/cinema/titles?${params.toString()}`);
    if (!r.ok) {
      const e = await r.json().catch(() => ({} as any));
      throw new Error(e.error ?? `http ${r.status}`);
    }
    const body = await r.json();
    return body.items ?? [];
  }

  // One-shot semantic search — returns items ranked by cosine similarity
  // to the query embedding. Caller handles state transitions; this is
  // pure fetch-and-throw.
  async function fetchSemantic(q: string, limit: number): Promise<ArchiveItem[]> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    const r = await apiFetch(`/api/cinema/search?${params.toString()}`);
    if (!r.ok) {
      const e = await r.json().catch(() => ({} as any));
      throw new Error(e.error ?? `http ${r.status}`);
    }
    const body = await r.json();
    return body.items ?? [];
  }

  // Reset + fetch first page. Single path now — the /titles endpoint
  // runs hybrid (FTS5+semantic+RRF) when there's a query, classic
  // listing when there isn't. Filters always layer on top.
  async function runSearch() {
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

  function pickCollection(slug: string) {
    collection = slug;
    viewWatchlist = false;
    runSearch();
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
    runSearch();
  }

  // toggleSemanticMode kept as a no-op for any leftover references —
  // safe to remove later once we audit. Hybrid search is now the only
  // path for non-empty queries.
  function toggleSemanticMode() { runSearch(); }
  function fmtDownloads(n?: number): string {
    if (!n) return '';
    if (n > 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n > 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }
  function fmtRuntime(sec?: number): string {
    if (!sec || sec <= 0) return '';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    return `${m}:${String(ss).padStart(2, '0')}`;
  }
</script>

<svelte:head><title>cinema — Kernl</title></svelte:head>

<div class="page">
  <!-- ── HERO / CHIPS ─────────────────────────────────────────── -->
  <header class="hero">
    <div class="hero-inner">
      <h1>cinema<span class="cur">█</span></h1>
      <span class="dim mini">
        {viewWatchlist
          ? `★ watchlist · ${watchlist.length} saved`
          : query.trim()
            ? `${items.length} resultados para "${query.trim()}"`
            : `catálogo local · ${items.length} cargados`}
      </span>
    </div>
    <nav class="chips">
      <button
        class="chip chip-star"
        class:on={viewWatchlist}
        on:click={() => (viewWatchlist = !viewWatchlist)}
        title="show items saved with the ★ button"
      >
        <span class="chip-icon">★</span>watchlist {watchlist.length ? `(${watchlist.length})` : ''}
      </button>
      <span class="chip-sep"></span>
      <button
        class="chip"
        class:on={embedPanelOpen}
        on:click={() => { embedPanelOpen = !embedPanelOpen; refreshEmbedStatus(); }}
        title="ver / lanzar embedder bge-m3"
      >
        <span class="chip-icon">⚙</span>embeddings{embedSnap?.status === 'running' ? ' ●' : ''}
      </button>
      <a class="chip" href="/cinema/directories" title="directorios comunitarios federados via Nostr">
        <span class="chip-icon">📁</span>directorios
      </a>
      {#if collection || activeTags.length > 0 || langFilter || yearMin || yearMax || query.trim() || sortMode !== 'downloads'}
        <button
          class="chip chip-star"
          on:click={clearAllFilters}
          title="clear all filters"
        >
          <span class="chip-icon">⊘</span>limpiar
        </button>
      {/if}
    </nav>
  </header>

  <!-- ── FILTERS BAR ─────────────────────────────────────────── -->
  <section class="filters">
    {#if !viewWatchlist}
      <input
        class="search"
        type="text"
        bind:value={query}
        placeholder='search — "ALF", "dracula", "silent films with vampires"… ↵'
        on:keydown={(e) => e.key === 'Enter' && runSearch()}
      />
      <div class="years" title="year range">
        <input type="number" bind:value={yearMin} placeholder="year ≥" min="1888" max="2099" />
        <span class="dim">—</span>
        <input type="number" bind:value={yearMax} placeholder="year ≤" min="1888" max="2099" />
      </div>
      <select class="lang-select" bind:value={langFilter} title="language">
        <option value="">language</option>
        <option value="en">English</option>
        <option value="es">Spanish</option>
        <option value="fr">French</option>
        <option value="de">German</option>
        <option value="it">Italian</option>
        <option value="pt">Portuguese</option>
        <option value="ja">Japanese</option>
        <option value="ru">Russian</option>
      </select>
      <select class="sort-select" bind:value={sortMode} on:change={runSearch} title="sort order (ignored while searching — BM25 + semantic ranking wins)">
        <option value="downloads">+ views</option>
        <option value="rating">+ rating</option>
        <option value="year_desc">year ↓</option>
        <option value="year_asc">year ↑</option>
        <option value="added_desc">added ↓</option>
      </select>
      <button class="primary" disabled={busy} on:click={runSearch}>
        {busy ? '…' : 'search'}
      </button>
    {:else}
      <span class="dim mini">★ tu watchlist · {watchlist.length} guardadas</span>
    {/if}
  </section>

  <!-- ── TAG CHIP ROW (top tags from the catalog) ─────────────── -->
  {#if !viewWatchlist && !semanticMode && topTags.length > 0}
    <section class="tag-chips">
      {#if activeTags.length > 0}
        <!-- Active tags first, with X to remove individually -->
        {#each activeTags as activeT (activeT)}
          {@const meta = topTags.find(t => t.tag_norm === activeT)}
          <button class="tag-chip on" on:click={() => pickTag(activeT)} title="remove this filter">
            ✕ {meta?.tag_display ?? activeT}
          </button>
        {/each}
        {#if activeTags.length >= 2}
          <button
            class="tag-chip tag-chip-mode"
            on:click={toggleTagsMatch}
            title="toggle between AND (all tags) / OR (any tag)"
          >
            {tagsMatch === 'all' ? '∧ all' : '∨ any'}
          </button>
        {/if}
        <button class="tag-chip tag-chip-clear" on:click={clearTags} title="clear all tags">
          ⊘ limpiar tags
        </button>
        <span class="tag-chip-sep"></span>
      {/if}
      {#each topTags.slice(0, 30) as tg (tg.tag_norm)}
        {#if !activeTags.includes(tg.tag_norm)}
          <button class="tag-chip" on:click={() => pickTag(tg.tag_norm)} title={`${tg.count.toLocaleString()} pelis · click para sumar al filtro`}>
            {tg.tag_display}
            <span class="tag-count dim">{tg.count > 999 ? (tg.count/1000).toFixed(1)+'k' : tg.count}</span>
          </button>
        {/if}
      {/each}

      <!-- Tag autocomplete — long-tail tags not in the top 30 -->
      <div class="tag-search-wrap">
        <input
          class="tag-search-input"
          type="text"
          bind:value={tagSearchQuery}
          placeholder="🔎 search tag…"
          on:input={onTagSearchInput}
          on:focus={() => { tagSearchOpen = true; if (tagSearchQuery) onTagSearchInput(); }}
          on:blur={closeTagSearchSoon}
        />
        {#if tagSearchOpen && (tagSearchHits.length > 0 || tagSearchBusy || tagSearchQuery.trim())}
          <div class="tag-search-popover">
            {#if tagSearchBusy}
              <div class="tag-search-empty dim mini">…</div>
            {:else if tagSearchHits.length === 0}
              <div class="tag-search-empty dim mini">sin matches para "{tagSearchQuery}"</div>
            {:else}
              {#each tagSearchHits as tg (tg.tag_norm)}
                <button
                  class="tag-search-row"
                  class:active={activeTags.includes(tg.tag_norm)}
                  on:mousedown|preventDefault={() => pickTagFromSearch(tg)}
                  title={`${tg.count.toLocaleString()} pelis · #${tg.rank}`}
                >
                  <span class="tag-search-name">
                    {#if activeTags.includes(tg.tag_norm)}✓{/if}
                    {tg.tag_display}
                  </span>
                  <span class="dim mini">{tg.count > 999 ? (tg.count/1000).toFixed(1)+'k' : tg.count}</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </section>
  {/if}

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
  <section class="grid">
    {#each shownItems as it (it.identifier)}
      <button
        class="card"
        on:click={() => openPlayer(it)}
        on:mouseenter={() => hoverItem = it.identifier}
        on:mouseleave={() => hoverItem === it.identifier && (hoverItem = null)}
      >
        <img class="poster" src={thumbUrl(it.identifier)} alt={it.title} loading="lazy" on:error={onPosterError} />

        <div class="overlay">
          <div class="ovl-title">{it.title || it.identifier}</div>
          <div class="ovl-meta">
            {#if it.date}<span class="badge">{it.date.slice(0, 4)}</span>{/if}
            {#if it.runtime_sec}<span class="badge runtime" title="duration">⏱ {fmtRuntime(it.runtime_sec)}</span>{/if}
            {#if it.creator}<span class="dim mini">{it.creator.length > 30 ? it.creator.slice(0, 30) + '…' : it.creator}</span>{/if}
            {#if it.downloads}<span class="dim mini">⇩ {fmtDownloads(it.downloads)}</span>{/if}
          </div>
        </div>

        <span
          class="star-btn"
          class:saved={isSaved(it.identifier)}
          role="button"
          tabindex="0"
          title={isSaved(it.identifier) ? 'remove from watchlist' : 'save to watchlist'}
          on:click|stopPropagation={() => toggleWatch(it)}
          on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && toggleWatch(it)}
        >{isSaved(it.identifier) ? '★' : '☆'}</span>
        <span
          class="dir-btn"
          role="button"
          tabindex="0"
          title="add to a directory"
          on:click={(ev) => openDirPopover(it.identifier, ev)}
          on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && openDirPopover(it.identifier, e)}
        >📁</span>
        {#if dirPopoverFor === it.identifier}
          <div class="dir-popover" on:click|stopPropagation>
            <div class="dir-popover-header">
              <strong>+ a directorio</strong>
              <button class="ghost sm" on:click={closeDirPopover}>×</button>
            </div>
            {#if myDirs.length === 0}
              <div class="dim mini">no directories yet.</div>
              <a class="ghost sm" href="/cinema/directories">+ crear uno</a>
            {:else}
              <ul class="dir-popover-list">
                {#each myDirs as d (d.id)}
                  <li>
                    <button on:click={() => addToDir(d.id, it.identifier)} disabled={dirPopoverBusy}>
                      <span class="dir-name">{d.title}</span>
                      <span class="dim mini">{d.item_count}</span>
                    </button>
                  </li>
                {/each}
              </ul>
              <a class="ghost sm" href="/cinema/directories">+ crear uno</a>
            {/if}
            {#if dirPopoverNotice}<div class="dir-popover-notice">{dirPopoverNotice}</div>{/if}
          </div>
        {/if}

        {#if hoverItem === it.identifier && it.description}
          <div class="hover-desc">
            <p>{it.description.length > 360 ? it.description.slice(0, 360) + '…' : it.description}</p>
            {#if it.subject?.length}
              <div class="tags">
                {#each it.subject.slice(0, 6) as s}<span class="tag">#{s}</span>{/each}
              </div>
            {/if}
          </div>
        {/if}
      </button>
    {:else}
      {#if !busy && !lastError}
        <div class="empty">{viewWatchlist ? '★ no items in your watchlist yet — click the ☆ on a card to save.' : 'no matches — try a different filter.'}</div>
      {:else if busy}
        <div class="empty loading">▮ loading from archive.org…</div>
      {/if}
    {/each}
  </section>

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
  {#if playOpen && playItem}
    <div class="modal-back" on:click|self={closePlayer} role="presentation">
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-head">
          <span class="modal-title">{playItem.title || playItem.identifier}</span>
          {#if playItem.date}<span class="badge">{playItem.date.slice(0, 4)}</span>{/if}
          {#if playItem.creator}<span class="dim mini">{playItem.creator}</span>{/if}
          <span class="spacer" />
          {#if playItem.description}
            <button
              class="ghost sm"
              class:on={descOpen}
              on:click={() => descOpen = !descOpen}
              title={descOpen ? 'hide description' : 'show description'}
            >
              ⓘ {descOpen ? 'hide' : 'info'}
            </button>
          {/if}
          {#if playFiles.length > 1}
            <button
              class="ghost sm"
              class:on={filesOpen}
              on:click={() => filesOpen = !filesOpen}
              title={filesOpen ? 'hide file list' : 'show file list'}
            >
              ▤ {filesOpen ? 'hide' : `files (${playFiles.length})`}
            </button>
          {/if}
          <a class="ghost sm" href="https://archive.org/details/{playItem.identifier}" target="_blank" rel="noopener">archive.org ↗</a>
          <button class="ghost sm" on:click={closePlayer}>× close</button>
        </header>

        <div class="modal-body">
          <div class="player">
            {#if playLoading}
              <div class="player-msg loading">▮ loading file list…</div>
            {:else if playError}
              <div class="player-msg err">⚠ {playError}</div>
            {:else if playSrc}
              {@const active = playFiles[playActiveIdx]}
              {#if active?.kind === 'video'}
                <div
                  class="video-stack"
                  class:fullscreen={isFullscreen}
                  class:controls-hidden={!controlsVisible}
                  data-debug-tracksrc={trackUrl ?? ''}
                  on:mousemove={showControls}
                  on:mouseleave={() => { if (playerIsPlaying && !settingsOpen) controlsVisible = false; }}
                  role="presentation"
                >
                  <!-- The <video> stays mounted across track changes (the <track>
                       is keyed on its own URL further down). Native controls are
                       OFF — we draw our own bar so caption font/size/colour and
                       translation engine all live in one settings popover. -->
                  <!-- No <track> child — we inject cues via
                       videoEl.addTextTrack() in loadTranscriptManual().
                       Doing it programmatically sidesteps Svelte/browser
                       quirks where {#if}/{#key} comment markers as direct
                       children of <video> stop the browser from parsing
                       the inner <track> element. -->
                  <!-- One player for cinema, TV and torrents. On demand:
                       full transport, scrubbing and speed. Captions, their
                       styling and the translation menu all live in its bar,
                       driven by the shared controller. -->
                  <KernlPlayer
                    bind:video={videoEl}
                    src={playSrc}
                    live={false}
                    autoplay={true}
                    crossorigin="anonymous"
                    ctl={subsCtl}
                    tick={subsTick}
                  >
                    <svelte:fragment slot="actions">
                      <button
                        class="cine-gear"
                        title="Subtitle pipeline"
                        on:click={() => (settingsOpen = !settingsOpen)}
                      >⚙</button>
                    </svelte:fragment>
                    <svelte:fragment slot="overlay">

                  {#if codecFallbackHint}
                    <div class="codec-fallback-banner" role="status">
                      <span class="cfb-spinner"></span>
                      {codecFallbackHint}
                    </div>
                  {/if}

                  <!-- Settings popover (over the video, top-right). Three tabs:
                       subs, style, speed. Closes when the user clicks outside
                       (handled by the .video-stack mousedown). -->
                  {#if settingsOpen}
                    <div
                      class="settings-popover"
                      role="dialog"
                      aria-label="player settings"
                      on:click|stopPropagation
                      on:mousedown|stopPropagation
                    >
                      <div class="settings-tabs">
                        <button class="tab-btn on">subtitles</button>
                        <!-- style + speed moved into the player's own menus
                             (Aa and the rate button) — one place for both. -->
                        <span class="spacer" />
                        <button class="tab-btn close-btn" on:click={() => settingsOpen = false} title="close">×</button>
                      </div>

                      {#if settingsTab === 'subs'}
                        <div class="settings-body subs-panel">

                          {#if subsMode === 'select'}
                            <!-- ─────────────────────────────────────────────
                                 SELECT MODE (default screen)
                                 One simple list. Click a language to switch
                                 captions instantly. "+ Generate" jumps to
                                 generate mode.
                                 ───────────────────────────────────────────── -->
                            <div class="cfg-block">
                              <div class="cfg-label">Subtitle</div>
                              <div class="cfg-row source-row">
                                <button class="src-pill" class:on={activeSubKey === 'off'} on:click={selectOff}>
                                  <span class="src-icon">⊘</span> Off
                                </button>
                                {#if hasSrt}
                                  <button class="src-pill" class:on={activeSubKey === 'shipped'} on:click={selectShipped}>
                                    <span class="src-icon">📜</span> Shipped <span class="src-badge">.srt · {subSourceLang}</span>
                                  </button>
                                {/if}
                                {#each cachedSubs as cs (cs.key)}
                                  <button class="src-pill" class:on={activeSubKey === cs.key} on:click={() => selectCachedSub(cs)} title={`${cs.kind} · ${cs.engine ?? ''} ${cs.model ?? ''}`}>
                                    <span class="src-icon">{cs.kind === 'translation' ? '🌐' : '🎙'}</span>
                                    {cs.kind === 'translation'
                                      ? `${(subInfo?.languages.find(l => l.iso === cs.tgt_lang)?.name ?? cs.tgt_lang)}`
                                      : `Auto-detected (${cs.src_lang})`}
                                    {#if cs.engine}<span class="src-badge">{shortModel(cs.engine)}</span>{/if}
                                  </button>
                                {/each}
                                {#if !hasSrt && cachedSubs.length === 0}
                                  <span class="empty-hint dim mini">no subtitle generated yet</span>
                                {/if}
                              </div>
                            </div>

                            <!-- ── Federated subtitle marketplace (Stage 4b) ── -->
                            <div class="cfg-block fed-block">
                              <div class="cfg-label-row">
                                <span class="cfg-label">🌐 Compartidos</span>
                                <span class="dim mini">{federatedSubs.length} in the index</span>
                                <button
                                  class="ghost sm"
                                  disabled={federatedRefreshing}
                                  on:click={() => loadFederatedSubs(true)}
                                  title="consultar Nostr y archive.org en vivo"
                                >
                                  {federatedRefreshing ? '…' : '↻ search the network'}
                                </button>
                                <label class="toggle-line dim mini" title="ocultar publicadores no marcados como confiables">
                                  <input type="checkbox" bind:checked={federatedTrustOnly} />
                                  trusted only
                                </label>
                              </div>

                              {#if federatedError}
                                <div class="fed-err">⚠ {federatedError}</div>
                              {/if}

                              {#if federatedShown.length === 0}
                                <div class="fed-empty dim mini">
                                  {federatedSubs.length === 0
                                    ? 'nothing shared for this film — try ↻ search the network'
                                    : 'ningún publicador trusted ofrece subs todavía'}
                                </div>
                              {:else}
                                <div class="fed-list">
                                  {#each federatedShown as row (row.rowId)}
                                    {@const pub = publishersMap[row.signerPubkey]}
                                    {@const trust = pub?.trust ?? 'unknown'}
                                    <div class="fed-row" class:downloaded={row.downloadedSubId} class:blocked={trust === 'blocked'}>
                                      <span class="fed-provider">
                                        {row.providerId === 'nostr' ? '⚡' : row.providerId === 'archive_org' ? '📦' : '·'}
                                        {row.providerId}
                                      </span>
                                      <span class="fed-lang">{row.tgtLang || '??'}</span>
                                      <span class="fed-engine dim mini">{row.engine || 'human'}</span>
                                      <span class="fed-signer dim mini" title={row.signerPubkey}>
                                        {row.signerPubkey ? (pub?.alias || shortPubkey(row.signerPubkey)) : '—'}
                                        {#if trust !== 'unknown'}<span class="fed-trust fed-trust-{trust}">{trust}</span>{/if}
                                      </span>
                                      <span class="fed-size dim mini">{fmtBytesShort(row.sizeBytes)}</span>
                                      {#if row.downloadedSubId}
                                        <span class="fed-status">✓ bajado</span>
                                      {:else}
                                        <button
                                          class="ghost sm"
                                          disabled={downloadingRowIds.has(row.rowId) || !row.webseedUrl}
                                          on:click={() => downloadFederated(row)}
                                          title={row.webseedUrl || 'sin webseed — magnet-only no soportado'}
                                        >
                                          {downloadingRowIds.has(row.rowId) ? '…' : 'bajar'}
                                        </button>
                                      {/if}
                                      {#if row.signerPubkey && trust === 'unknown'}
                                        <button class="ghost sm" on:click={() => setPublisherTrust(row.signerPubkey, 'trusted')} title="marcar publicador como confiable">★</button>
                                        <button class="ghost sm" on:click={() => setPublisherTrust(row.signerPubkey, 'blocked')} title="bloquear publicador">⊘</button>
                                      {/if}
                                    </div>
                                  {/each}
                                </div>
                              {/if}
                            </div>

                            <button class="cta-btn cta-generate-new" on:click={() => subsMode = 'generate'}>
                              ＋ Generate new subtitle
                            </button>

                          {:else}
                            <!-- ─────────────────────────────────────────────
                                 GENERATE MODE
                                 Minimal form — pick a language, click Start.
                                 Engine/model defaults are auto-picked; user
                                 only sees them via the "Advanced" link.
                                 ───────────────────────────────────────────── -->
                            <button class="back-link" on:click={() => subsMode = 'select'}>
                              ← Back to subtitle list
                            </button>

                            <div class="cfg-block">
                              <div class="cfg-label">Generate subtitle in</div>
                              <select class="cfg-select cfg-select-lg" bind:value={subTargetLang} on:change={() => translateActive = subTargetLang !== subSourceLang}>
                                <option value={subSourceLang}>Audio language ({subSourceLang}) — transcribe only</option>
                                {#each (subInfo?.languages ?? []).filter(l => l.iso !== subSourceLang) as l}
                                  <option value={l.iso}>{l.name} ({l.iso}) — transcribe + translate</option>
                                {/each}
                              </select>
                            </div>

                            <!-- Pipeline summary using current saved settings -->
                            <div class="pipeline-preview">
                              <div class="pp-label">▸ pipeline</div>
                              <div class="pp-line">
                                <span class="pp-step">whisper <strong>{transcribeEngine}</strong>/<strong>{transcribeModel}</strong></span>
                                {#if subTargetLang !== subSourceLang}
                                  <span class="pp-arrow">→</span>
                                  <span class="pp-step">translate via <strong>{subEngine}</strong></span>
                                {/if}
                              </div>
                            </div>

                            <!-- Advanced — engine config (saved across runs) -->
                            <button class="adv-toggle" class:open={advancedOpen} on:click={() => advancedOpen = !advancedOpen}>
                              <span class="adv-caret">{advancedOpen ? '▾' : '▸'}</span>
                              <span class="adv-label">Engine settings</span>
                              <span class="adv-hint">{advancedOpen ? 'these are saved for next time' : 'whisper engine, translation engine'}</span>
                            </button>

                            {#if advancedOpen}
                              <div class="adv-body">
                                {#if transcribeInfo}
                                  <div class="cfg-block">
                                    <div class="cfg-label">Whisper (transcribe)</div>
                                    <div class="cfg-row">
                                      <select class="cfg-select" bind:value={transcribeEngine} disabled={transcribeBusy}>
                                        {#if transcribeInfo.engines.groq.available}<option value="groq">groq · cloud · ~30s</option>{/if}
                                        {#if transcribeInfo.engines.whispercpp.available}<option value="whispercpp">whisper.cpp · CPU · 3–8 min</option>{/if}
                                        {#if transcribeInfo.engines.transformers.available}<option value="transformers">transformers · CPU · 10–20 min</option>{/if}
                                      </select>
                                      <select class="cfg-select" bind:value={transcribeModel} disabled={transcribeBusy}>
                                        {#each transcribeInfo.models as m}<option value={m}>{m}</option>{/each}
                                      </select>
                                    </div>
                                  </div>
                                {/if}
                                {#if subTargetLang !== subSourceLang}
                                  <div class="cfg-block">
                                    <div class="cfg-label">Translation engine</div>
                                    <div class="engine-grid">
                                      {#if subInfo?.engines.llm.available}
                                        <button class="engine-tile" class:on={subEngine === 'llm'} on:click={() => subEngine = 'llm'}>
                                          <span class="et-name">Auto (chain)
                                            <span class="et-badge">/models</span>
                                          </span>
                                          <span class="et-meta">{subInfo.engines.llm.primary.slug}{shortModel(subInfo.engines.llm.primary.model) ? ' · ' + shortModel(subInfo.engines.llm.primary.model) : ''}</span>
                                          <span class="et-time">~30s–5 min · falls back automatically</span>
                                        </button>
                                      {/if}
                                      {#if subInfo?.engines.nllb.available}
                                        <button class="engine-tile" class:on={subEngine === 'nllb'} on:click={() => subEngine = 'nllb'}>
                                          <span class="et-name">NLLB</span>
                                          <span class="et-meta">offline CPU · 200 langs</span>
                                          <span class="et-time">~5–10 min · free</span>
                                        </button>
                                      {/if}
                                    </div>
                                    {#if subInfo?.engines.llm.available && subInfo.engines.llm.fallbacks.length > 0}
                                      <div class="cfg-hint">
                                        Fallbacks: {subInfo.engines.llm.fallbacks.map(f => f.slug + (f.available ? '' : ' (no key)')).join(' → ')}
                                      </div>
                                    {/if}
                                  </div>
                                {/if}
                              </div>
                            {/if}

                            <button
                              class="cta-btn cta-apply"
                              disabled={transcribeBusy || translateBusy}
                              on:click={() => { subSource = 'auto'; translateActive = subTargetLang !== subSourceLang; applySubs(); }}
                            >
                              {#if transcribeBusy || translateBusy}
                                ⚙ working…
                              {:else}
                                ▶ Start generation
                              {/if}
                            </button>

                            {#if transcribeError}
                              <div class="inline-err">{transcribeError}</div>
                            {/if}
                            {#if translateError}
                              <div class="inline-err">{translateError} <button class="dismiss-mini" on:click={() => translateError = ''}>×</button></div>
                            {/if}
                          {/if}

                          <!-- ── PLAYBACK · OVERRIDE (force-transcode) ─────── -->
                          <div class="force-transcode-row">
                            <label class="force-transcode-toggle">
                              <input
                                type="checkbox"
                                checked={playNeedsTranscode}
                                on:change={onForceTranscodeToggle}
                              />
                              <span class="ftt-knob"></span>
                              <span class="ftt-text">
                                <span class="ftt-title">Force transcode (ffmpeg)</span>
                                <span class="ftt-sub dim">enable if the video is black but audio plays — slower, no seeking</span>
                              </span>
                            </label>
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/if}
                    </svelte:fragment>
                  </KernlPlayer>

                  <!-- ── ONE big centered modal for BOTH phases ────────
                       transcribe → translate (the user wanted the same
                       beautiful design for both, no tiny corner card).
                       Title/meta/eta/hint all swap on translateMode. -->
                  {#if transcribeBusy || translateBusy}
                    {@const isTr = translateBusy && translateMode === 'translate'}
                    {@const elapsedMs = isTr ? translateElapsedMs : transcribeElapsedMs}
                    {@const hasKernelProgress = isTr
                      ? translateCuesTotal > 0
                      : (transcribeSubPhase !== '' || transcribeFrac > 0)}
                    {@const ratio = isTr
                      ? (translateCuesTotal > 0
                          ? Math.min(1, translateCuesDone / translateCuesTotal)
                          : 0)
                      : Math.max(0, Math.min(1, transcribeFrac))}
                    {@const indeterminate = !hasKernelProgress || (!isTr && transcribeFrac === 0)}
                    {@const etaMs = isTr
                      ? (translateEtaMs > 0 ? translateEtaMs : (estimateTranslateMs() ?? 0))
                      : 0}
                    {@const audioRate = (!isTr && transcribeSubPhase === 'transcribe' && transcribeProcessedSec > 0 && elapsedMs > 0)
                      ? transcribeProcessedSec / (elapsedMs / 1000)
                      : 0}
                    {@const transcribeEtaMs = (!isTr && transcribeSubPhase === 'transcribe' && transcribeFrac > 0 && transcribeFrac < 1 && elapsedMs > 0)
                      ? Math.max(0, (elapsedMs / transcribeFrac) - elapsedMs)
                      : 0}
                    {@const tgtName = subInfo?.languages.find(l => l.iso === subTargetLang)?.name ?? subTargetLang}
                    <div class="transcribe-overlay" role="status" aria-live="polite">
                      <div class="transcribe-card" class:translating={isTr}>
                        <div class="transcribe-spinner" aria-hidden="true">
                          <span></span><span></span><span></span><span></span>
                        </div>
                        <div class="transcribe-title">
                          {isTr ? `Translating to ${tgtName}…` : transcribePhaseTitle()}
                        </div>
                        <!-- Meta line: just engine / model identity. Times moved
                             below the bar so audio-progress and wall-clock can be
                             clearly distinguished with their own labels. -->
                        <div class="transcribe-meta">
                          <span class="kbd">{isTr ? subEngine : transcribeEngine}</span>
                          <span class="dim">·</span>
                          <span class="kbd">{isTr ? `${subSourceLang} → ${subTargetLang}` : transcribeModel}</span>
                          {#if !isTr && ratio > 0}
                            <span class="dim">·</span>
                            <span class="meta-pct">{(ratio * 100).toFixed(0)}%</span>
                          {/if}
                        </div>
                        <div class="transcribe-bar" class:indeterminate>
                          {#if !indeterminate}
                            <div class="transcribe-bar-fill" style="width: {(ratio * 100).toFixed(1)}%"></div>
                          {/if}
                          <div class="transcribe-bar-shimmer"></div>
                        </div>
                        <!-- Stats grid: two clearly-labelled groups so the user
                             never has to guess what each number means.
                               🎬 AUDIO  — what whisper is chewing through
                               ⏱  CLOCK  — what the user is actually waiting -->
                        <div class="transcribe-stats">
                          {#if isTr && hasKernelProgress}
                            <span class="ts-chip ts-cues">
                              <span class="ts-ico">📝</span>
                              <span class="ts-lbl">cues</span>
                              <strong>{translateCuesDone} / {translateCuesTotal}</strong>
                            </span>
                          {:else if !isTr && transcribeSubPhase === 'load-model' && (transcribeProcessedSec > 0 || transcribeTotalSec > 0)}
                            <span class="ts-chip ts-download">
                              <span class="ts-ico">⬇</span>
                              <span class="ts-lbl">model</span>
                              <strong>{transcribeProcessedSec.toFixed(1)}{transcribeTotalSec > 0 ? ` / ${transcribeTotalSec.toFixed(1)}` : ''} MB</strong>
                            </span>
                          {:else if !isTr && (transcribeSubPhase === 'extract' || transcribeSubPhase === 'transcribe') && (transcribeProcessedSec > 0 || transcribeTotalSec > 0)}
                            <span class="ts-chip ts-audio">
                              <span class="ts-ico">🎬</span>
                              <span class="ts-lbl">audio</span>
                              <strong>
                                {#if transcribeProcessedSec > 0 && transcribeTotalSec > 0}
                                  {fmtAudio(transcribeProcessedSec)} / {fmtAudio(transcribeTotalSec)}
                                {:else if transcribeTotalSec > 0}
                                  {fmtAudio(transcribeTotalSec)} total
                                {/if}
                              </strong>
                              {#if audioRate > 0}
                                <span class="ts-rate" title="Audio-seconds processed per wall-clock second">{audioRate.toFixed(audioRate < 1 ? 2 : 1)}×</span>
                              {/if}
                            </span>
                          {/if}
                          <span class="ts-chip ts-clock">
                            <span class="ts-ico">⏱</span>
                            <span class="ts-lbl">clock</span>
                            <strong>{fmtElapsed(elapsedMs)}</strong>
                            {#if !isTr && transcribeEtaMs > 0}
                              <span class="ts-eta" title="Estimated wall-clock time remaining at current rate">~{fmtElapsed(transcribeEtaMs)} left</span>
                            {:else if isTr && etaMs > 0}
                              <span class="ts-eta" title={hasKernelProgress ? 'Estimated remaining' : 'Rough estimate (no kernel progress yet)'}>~{fmtElapsed(etaMs)} {hasKernelProgress ? 'left' : 'est.'}</span>
                            {/if}
                          </span>
                        </div>
                        <div class="transcribe-hint dim mini">
                          {#if isTr && hasKernelProgress}
                            {subEngine} translated {translateCuesDone} of {translateCuesTotal} cues — captions will refresh when ready
                          {:else if isTr}
                            {subEngine} translating {transcribeCueCount || ''} cues — captions will refresh when ready
                          {:else if transcribeSubPhase === 'load-model'}
                            first-time setup — the {transcribeModel} model will be cached for next time
                          {:else if transcribeSubPhase === 'extract'}
                            ffmpeg is streaming the audio from archive.org through the kernel proxy
                          {:else if transcribeSubPhase === 'transcribe'}
                            whisper.cpp running on CPU{transcribeHint ? ` · ${transcribeHint}` : ''} — captions will pop in when ready
                          {:else}
                            whisper runs locally — keep watching, the captions will pop in when ready
                          {/if}
                        </div>
                        <button class="transcribe-cancel" on:click={cancelGenerateSubs}>
                          ⊗ Cancel
                        </button>
                      </div>
                    </div>
                  {:else if transcribeJustDone}
                    <div class="transcribe-toast" role="status">
                      <span class="check">✓</span>
                      subtitles ready{transcribeCueCount ? ` · ${transcribeCueCount} cues` : ''}
                    </div>
                  {:else if translateError}
                    <div class="translate-error" role="alert">
                      <span class="t-err-icon">⚠</span>
                      <div class="t-err-body">
                        <strong>Translation failed</strong>
                        <div class="dim mini">{translateError}</div>
                      </div>
                      <button class="t-err-dismiss" on:click={() => translateError = ''} title="dismiss">×</button>
                    </div>
                  {/if}
                </div>
              {:else if active?.kind === 'audio'}
                <audio src={playSrc} controls autoplay></audio>
              {:else if active?.kind === 'image'}
                <img src={playSrc} alt={active.name} />
              {/if}
              {#if playNeedsTranscode}
                <div class="transcode-note dim mini">⚙ live-transcoding {active?.name.split('.').pop()?.toUpperCase()} → mp4 via ffmpeg · seek disabled · 1-3s startup</div>
              {/if}
              <!-- subs / engine / language / font / size all moved into the
                   custom player's settings popover (gear icon over video). -->
            {/if}
          </div>

          {#if playFiles.length > 1 && filesOpen}
            <div class="filelist filelist-bottom">
              <div class="filelist-head-row">
                <span class="dim mini filelist-head">{playFiles.length} files · click to switch</span>
                <button class="filelist-close" on:click={() => filesOpen = false} title="hide">×</button>
              </div>
              <div class="filelist-row">
                {#each playFiles as f, idx}
                  <button class="file-row" class:on={idx === playActiveIdx} on:click={() => selectPlayFile(idx)}>
                    <span class="kind kind-{f.kind}">{f.kind[0].toUpperCase()}</span>
                    <span class="fname">{f.name}</span>
                    <span class="dim mini">{fmtBytes(f.size)}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        {#if playItem.description && descOpen}
          <div class="modal-desc" role="region" aria-label="Item description">
            <div class="modal-desc-head">
              <span class="modal-desc-label">▸ DESCRIPTION</span>
              <span class="spacer" />
              <button class="modal-desc-close" on:click={() => descOpen = false} title="close">×</button>
            </div>
            <div class="modal-desc-body">
              {playItem.description.length > 1200 ? playItem.description.slice(0, 1200) + '…' : playItem.description}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  :global(body) { background: #050807; }

  .page {
    padding: 0 0 60px;
    color: var(--green, #33ff77);
    font-family: var(--font-mono, monospace);
    background:
      radial-gradient(circle at top right, rgba(51, 255, 119, 0.04), transparent 40%),
      radial-gradient(circle at 30% 20%, rgba(255, 176, 0, 0.03), transparent 50%),
      #050807;
    /* full-bleed parent (.main-inner) is a flex column with overflow:hidden,
       so this element must own its own scroll container — otherwise the
       grid grows past the viewport and gets clipped with no scrollbar. */
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* ─── HERO ───────────────────────────────────────────────── */
  .hero {
    padding: 22px 32px 12px;
    border-bottom: 1px solid var(--line, #1d3a26);
    background: linear-gradient(180deg, rgba(255, 176, 0, 0.04), transparent);
    position: sticky;
    top: 0;
    z-index: 5;
    backdrop-filter: blur(8px);
  }
  .hero-inner { display: flex; align-items: baseline; gap: 14px; margin-bottom: 12px; }
  .hero h1 {
    font-family: var(--font-display, monospace);
    font-size: 30px;
    letter-spacing: 0.06em;
    color: var(--amber, #ffb000);
    text-shadow: 0 0 12px rgba(255, 176, 0, 0.5);
    margin: 0;
  }
  .cur { animation: blink 1s steps(2) infinite; opacity: 0.7; }
  @keyframes blink { 50% { opacity: 0; } }

  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    background: transparent;
    border: 1px solid var(--line, #1d3a26);
    color: var(--green-dim, #4d8a5a);
    padding: 4px 10px 4px 8px;
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    font-size: 11.5px;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    transition: all 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .chip:hover { color: var(--green, #33ff77); border-color: var(--green-dim, #4d8a5a); }
  .chip.on {
    background: rgba(255, 176, 0, 0.08);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.6);
  }
  .chip-icon { font-size: 13px; }

  /* ─── FILTERS BAR ────────────────────────────────────────── */
  .filters {
    display: flex;
    align-items: stretch;            /* forces every control to take the row height */
    gap: 8px;
    padding: 12px 32px;
    flex-wrap: wrap;
    border-bottom: 1px dashed var(--line, #1d3a26);
  }
  /* All filter-bar controls share the same box: 32px tall, identical
     padding, same font-size. Per-control width is the only thing that
     varies. This keeps the row visually uniform whether it has inputs,
     selects, or buttons. */
  .filters > .search,
  .filters > .years input,
  .filters > .rows,
  .filters > .lang-select,
  .filters > .sort-select,
  .filters > button.primary {
    height: 32px;
    box-sizing: border-box;
    padding: 0 12px;
    font-size: 13px;
    line-height: 30px;               /* visually centers text inside fixed height */
    border-radius: 2px;
  }
  .search {
    flex: 1 1 320px;
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green, #33ff77);
    font: inherit;
    outline: none;
  }
  .search:focus { border-color: var(--amber, #ffb000); box-shadow: 0 0 6px rgba(255, 176, 0, 0.2); }
  .years {
    display: flex;
    align-items: stretch;
    gap: 6px;
  }
  .years input, .rows {
    width: 80px;
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green, #33ff77);
    font: inherit;
    outline: none;
    height: 32px;
    box-sizing: border-box;
    padding: 0 10px;
    font-size: 13px;
    line-height: 30px;
  }
  .years .dim {
    align-self: center;
  }
  .spacer { flex: 1; }

  /* ─── BUTTONS ────────────────────────────────────────────── */
  button.primary {
    background: var(--green-deep, #0d2516);
    border: 1px solid var(--green, #33ff77);
    color: var(--green, #33ff77);
    padding: 0 16px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    border-radius: 2px;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    height: 32px;
    box-sizing: border-box;
    line-height: 30px;
  }
  button.primary:hover:not(:disabled) {
    background: var(--green, #33ff77);
    color: #050807;
    box-shadow: 0 0 14px rgba(51, 255, 119, 0.4);
  }
  button.primary.go {
    background: rgba(255, 176, 0, 0.08);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
  }
  button.primary.go:hover:not(:disabled) {
    background: var(--amber, #ffb000);
    color: #050807;
    box-shadow: 0 0 16px rgba(255, 176, 0, 0.5);
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
    border-radius: 2px;
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
    border-radius: 2px;
  }
  .hint {
    margin: 12px 32px;
    padding: 8px 14px;
    border: 1px dashed var(--dim-fg, #6a7a6a);
    color: var(--dim-fg, #99a);
    background: rgba(255, 255, 255, 0.02);
    border-radius: 2px;
    font-size: 0.92em;
  }
  /* ── Tag chip row (top tags from catalog) ─────────────────── */
  .tag-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 4px 32px 12px;
    padding: 8px 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    background: rgba(255, 255, 255, 0.015);
  }
  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    color: var(--text-2, #c0c0c0);
    font-size: 12px;
    cursor: pointer;
    transition: all 120ms;
  }
  .tag-chip:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.18);
    color: var(--text-1, #fff);
  }
  .tag-chip.on {
    background: rgba(255, 176, 0, 0.18);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
  }
  .tag-count {
    font-size: 10px;
    opacity: 0.6;
  }
  /* ── Long-tail tag autocomplete ─────────────────────────── */
  .tag-search-wrap {
    position: relative;
    display: inline-flex;
  }
  .tag-search-input {
    height: 26px;
    padding: 0 10px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--text-1, #e5e5e5);
    border-radius: 999px;
    font: inherit;
    font-size: 12px;
    outline: none;
    width: 160px;
    transition: width 200ms ease, border-color 120ms;
  }
  .tag-search-input:focus {
    border-color: var(--amber, #ffb000);
    width: 220px;
  }
  .tag-search-input::placeholder {
    color: var(--dim-fg, #888);
  }
  .tag-search-popover {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    min-width: 280px;
    max-height: 320px;
    overflow-y: auto;
    background: var(--bg-1, #0a1812);
    border: 1px solid var(--amber, #ffb000);
    border-radius: 4px;
    z-index: 20;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
    padding: 4px 0;
  }
  .tag-search-empty {
    padding: 8px 12px;
  }
  .tag-search-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: transparent;
    border: none;
    color: var(--text-1, #e5e5e5);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    text-align: left;
  }
  .tag-search-row:hover {
    background: rgba(255, 176, 0, 0.1);
    color: var(--amber, #ffb000);
  }
  .tag-search-row.active {
    color: var(--amber, #ffb000);
    background: rgba(255, 176, 0, 0.06);
  }
  .tag-search-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    margin-right: 8px;
  }
  /* ── Inline filter selects ────────────────────────────────── */
  /* Match exact dimensions of the year/rows inputs so the bar is a
     single horizontal beam. Native <select> ignores line-height for
     the option text but the dropdown arrow still aligns. */
  .lang-select, .sort-select {
    height: 32px;
    box-sizing: border-box;
    padding: 0 10px;
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green, #33ff77);
    font-family: inherit;
    font-size: 13px;
    border-radius: 2px;
    cursor: pointer;
    /* Keep arrow space readable; native appearance varies per OS. */
    appearance: auto;
  }
  .lang-select:focus, .sort-select:focus {
    border-color: var(--amber, #ffb000);
    outline: none;
    box-shadow: 0 0 6px rgba(255, 176, 0, 0.2);
  }
  /* ── Embed admin panel ────────────────────────────────────── */
  .embed-panel {
    margin: 0 32px 12px;
    padding: 12px 16px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 176, 0, 0.25);
    border-radius: 2px;
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
  /* ── Federated subtitle marketplace ────────────────────────── */
  .fed-block { border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; margin-top: 8px; }
  .cfg-label-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
  .toggle-line { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
  .fed-empty { padding: 6px 0; }
  .fed-err {
    margin: 4px 0 8px;
    padding: 6px 10px;
    border: 1px solid var(--red, #f55);
    color: var(--red, #f55);
    background: rgba(255, 60, 60, 0.06);
    border-radius: 2px;
    font-size: 0.9em;
  }
  .fed-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
  .fed-row {
    display: grid;
    grid-template-columns: auto auto auto 1fr auto auto auto;
    gap: 8px;
    align-items: center;
    padding: 4px 8px;
    border: 1px solid rgba(255,255,255,0.04);
    border-radius: 2px;
    font-size: 0.88em;
  }
  .fed-row.downloaded { background: rgba(60, 200, 100, 0.04); }
  .fed-row.blocked { opacity: 0.4; }
  .fed-provider { font-weight: 600; }
  .fed-lang { text-transform: uppercase; font-weight: 700; min-width: 26px; text-align: center; }
  .fed-status { color: var(--green, #4d8); font-size: 0.85em; }
  .fed-trust {
    display: inline-block;
    margin-left: 4px;
    padding: 0 4px;
    border-radius: 2px;
    font-size: 0.85em;
  }
  .fed-trust-mine    { background: rgba(120, 180, 255, 0.18); color: #9cf; }
  .fed-trust-trusted { background: rgba(80, 220, 130, 0.18); color: #6e8; }
  .fed-trust-blocked { background: rgba(255, 80, 80, 0.18); color: #f88; }
  .result {
    margin: 12px 32px;
    padding: 8px 14px;
    border: 1px dashed var(--green-dim, #4d8a5a);
    border-radius: 2px;
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    font-size: 12.5px;
  }
  .result .ok { color: var(--amber, #ffb000); font-weight: 600; }
  .result .warn { color: var(--yellow, #d4a017); cursor: pointer; }
  .result a { color: var(--cyan, #4dd0e1); text-decoration: none; }
  .result a:hover { text-decoration: underline; }
  .result ul { margin: 6px 0 0 14px; font-size: 11px; }

  /* ─── POSTER GRID ────────────────────────────────────────── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 10px;
    padding: 14px 24px;
  }

  .card {
    position: relative;
    aspect-ratio: 4 / 3;
    border: 1px solid var(--line, #1d3a26);
    background: #0a0a0a;
    cursor: pointer;
    overflow: hidden;
    border-radius: 3px;
    padding: 0;
    text-align: left;
    color: inherit;
    transition: transform 0.18s ease, border-color 0.18s, box-shadow 0.18s;
  }
  .card:hover {
    transform: scale(1.04) translateY(-2px);
    border-color: var(--amber, #ffb000);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.7), 0 0 18px rgba(255, 176, 0, 0.18);
    z-index: 2;
  }
  .card.on {
    border-color: var(--amber, #ffb000);
    box-shadow: 0 0 0 2px var(--amber, #ffb000), 0 6px 20px rgba(0, 0, 0, 0.7);
  }
  .card.on:hover { transform: scale(1.04) translateY(-2px); }

  .poster {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    transition: transform 0.3s ease, opacity 0.3s;
    opacity: 1;
    background: linear-gradient(135deg, #142219, #050807);
  }
  .card:hover .poster { transform: scale(1.02); }

  /* Bottom gradient + title */
  .overlay {
    position: absolute;
    inset: auto 0 0 0;
    padding: 10px 12px;
    background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.85) 60%, rgba(0, 0, 0, 0.95) 100%);
    color: #fff;
    pointer-events: none;
  }
  .ovl-title {
    color: var(--amber, #ffb000);
    font-size: 13px;
    line-height: 1.25;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
    margin-bottom: 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ovl-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 10.5px; }
  .ovl-meta .badge {
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--green-dim, #4d8a5a);
    color: var(--amber, #ffb000);
    padding: 0 6px;
    border-radius: 2px;
    font-size: 10px;
  }
  .ovl-meta .badge.runtime {
    color: #cfe8d0;
    border-color: rgba(207, 232, 208, 0.35);
    letter-spacing: 0.02em;
  }
  .ovl-meta .dim { color: #b0c8b8; }

  .check {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--amber, #ffb000);
    color: #050807;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.6);
  }

  /* ▶ play button on each card */
  .play-btn {
    position: absolute;
    top: 8px;
    left: 8px;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: var(--green, #33ff77);
    border: 1px solid var(--green-dim, #4d8a5a);
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transform: scale(0.85);
    transition: all 0.15s ease;
    z-index: 3;
  }
  .play-btn:hover, .play-btn:focus {
    background: var(--green, #33ff77);
    color: #050807;
    border-color: var(--green, #33ff77);
    box-shadow: 0 0 14px rgba(51, 255, 119, 0.6);
    outline: none;
  }
  .card:hover .play-btn { opacity: 1; transform: scale(1); }

  /* ★ watchlist toggle on each card */
  .star-btn {
    position: absolute;
    top: 8px;
    left: 48px;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: var(--green-dim, #4d8a5a);
    border: 1px solid var(--green-dim, #4d8a5a);
    font-size: 16px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transform: scale(0.85);
    transition: all 0.15s ease;
    z-index: 3;
  }
  .star-btn.saved {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.4);
    opacity: 1;
    transform: scale(1);
  }
  .star-btn:hover, .star-btn:focus {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    background: rgba(0, 0, 0, 0.8);
    outline: none;
  }
  .card:hover .star-btn { opacity: 1; transform: scale(1); }

  /* Folder (📁 add-to-directory) — same styling as star, just shifted right
     and uses a different default tint until the popover is open. */
  .dir-btn {
    position: absolute;
    top: 8px;
    left: 86px;                      /* sits right of the star */
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: var(--green-dim, #4d8a5a);
    border: 1px solid var(--green-dim, #4d8a5a);
    font-size: 14px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transform: scale(0.85);
    transition: all 0.15s ease;
    z-index: 3;
  }
  .dir-btn:hover, .dir-btn:focus {
    color: var(--cyan, #4dd0e1);
    border-color: var(--cyan, #4dd0e1);
    background: rgba(0, 0, 0, 0.8);
    outline: none;
  }
  .card:hover .dir-btn { opacity: 1; transform: scale(1); }
  .dir-popover {
    position: absolute;
    top: 48px;
    left: 8px;
    z-index: 10;
    background: var(--bg-1, #0a1812);
    border: 1px solid var(--cyan, #4dd0e1);
    border-radius: 2px;
    padding: 8px 10px;
    min-width: 220px;
    max-height: 280px;
    overflow-y: auto;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
    text-align: left;
  }
  .dir-popover-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 8px;
    color: var(--cyan, #4dd0e1);
    font-size: 12px;
  }
  .dir-popover-list { list-style: none; padding: 0; margin: 0 0 6px; }
  .dir-popover-list li button {
    width: 100%;
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-1, #e5e5e5);
    cursor: pointer;
    font: inherit; font-size: 12px;
    border-radius: 2px;
  }
  .dir-popover-list li button:hover { background: rgba(77, 208, 225, 0.1); border-color: var(--cyan, #4dd0e1); }
  .dir-popover-list li button:disabled { opacity: 0.5; cursor: wait; }
  .dir-name { text-align: left; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-popover-notice { font-size: 11px; color: var(--green, #4d8); margin-top: 6px; }

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

  /* ─── PLAYER MODAL ────────────────────────────────────── */
  /* ── Modal: control-room enclosure ──────────────────────────
     Sharp 90° corners, scanline overlay, corner brackets that
     hint at a CRT bezel without overwhelming the content.       */
  .modal-back {
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(0, 4, 1, 0.5) 0%, rgba(0, 0, 0, 0.92) 100%);
    backdrop-filter: blur(6px);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    animation: fade 0.18s ease-out;
  }
  .modal {
    position: relative;
    background: #050807;
    border: 1px solid var(--amber, #ffb000);
    box-shadow:
      0 0 80px rgba(255, 176, 0, 0.18),
      0 0 1px rgba(255, 176, 0, 0.6),
      inset 0 0 80px rgba(0, 0, 0, 0.7);
    width: min(1100px, 100%);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    border-radius: 0;          /* hard CRT bezel — no soft corners */
    overflow: hidden;
  }
  /* Static scanlines on top of the entire modal — half-pixel rows so the
     pattern stays crisp on retina without moiré. Pointer-events off so it
     never hijacks clicks; mix-blend-mode keeps the underlying colours. */
  .modal::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 50;
    background: repeating-linear-gradient(
      to bottom,
      rgba(255, 255, 255, 0) 0,
      rgba(255, 255, 255, 0) 2px,
      rgba(0, 0, 0, 0.18) 2px,
      rgba(0, 0, 0, 0.18) 3px
    );
    mix-blend-mode: multiply;
    opacity: 0.55;
  }
  /* Corner brackets — purely decorative, mark the modal as a "framed" panel.
     Drawn with two box-shadows per corner via the four ::after segments
     would be heavy; instead we use a single ::after with linear-gradient
     to paint L-shaped marks at the four corners of the modal. */
  .modal::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 51;
    background:
      /* top-left  */
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 14px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 1px 14px no-repeat,
      /* top-right */
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 14px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 1px 14px no-repeat,
      /* bottom-left  */
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 14px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 1px 14px no-repeat,
      /* bottom-right */
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 14px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 1px 14px no-repeat;
    opacity: 0.85;
    filter: drop-shadow(0 0 3px rgba(255, 176, 0, 0.6));
  }

  /* ── Modal header: channel ID strip ─────────────────────────
     Monospaced title with phosphor glow, year/creator pinned as
     mono-tabular pieces, action buttons in lower-case "command"
     style (`[archive.org ↗]` `[× close]`).                      */
  .modal-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 22px 12px;
    border-bottom: 1px solid var(--line, #1d3a26);
    background:
      linear-gradient(180deg, rgba(255, 176, 0, 0.07), transparent 70%),
      linear-gradient(90deg, transparent, rgba(255, 176, 0, 0.04), transparent);
    flex-wrap: wrap;
    z-index: 1;
  }
  /* The little ▮ glyph + "CH:" prefix sells the broadcast metaphor. */
  .modal-head::before {
    content: "▮ CH";
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    color: var(--amber, #ffb000);
    letter-spacing: 0.18em;
    opacity: 0.7;
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.5);
    align-self: center;
    padding: 1px 6px;
    border: 1px solid rgba(255, 176, 0, 0.35);
    border-radius: 0;
  }
  .modal-title {
    color: var(--amber, #ffb000);
    font-family: var(--font-display, var(--font-mono, monospace));
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-shadow: 0 0 8px rgba(255, 176, 0, 0.45), 0 0 1px rgba(255, 176, 0, 0.9);
    flex: 1 1 280px;
    line-height: 1.25;
    word-break: break-word;
    text-transform: uppercase;
  }
  .modal-head .badge {
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid var(--green-dim, #4d8a5a);
    color: var(--amber, #ffb000);
    padding: 2px 7px;
    border-radius: 0;
    font-size: 10px;
    font-family: var(--font-mono, ui-monospace), monospace;
    letter-spacing: 0.1em;
    font-variant-numeric: tabular-nums;
  }
  .modal-head .dim.mini {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.05em;
    opacity: 0.7;
  }
  .modal-head a.ghost, .modal-head button.ghost {
    text-decoration: none;
    background: transparent;
    border: 1px solid var(--line, #1d3a26);
    color: var(--green-dim, #4d8a5a);
    padding: 4px 11px;
    cursor: pointer;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.08em;
    border-radius: 0;
    text-transform: uppercase;
    transition: color 100ms, border-color 100ms, box-shadow 120ms;
  }
  .modal-head a.ghost:hover, .modal-head button.ghost:hover {
    color: var(--green, #33ff77);
    border-color: var(--green, #33ff77);
    box-shadow: 0 0 6px rgba(51, 255, 119, 0.35), inset 0 0 6px rgba(51, 255, 119, 0.1);
  }

  .modal-body {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-height: 0;
    background: #000;
    overflow: hidden;
  }
  .player {
    width: 100%;
    /* Player gets a guaranteed min-height so the video isn't tiny, but
       it CAN shrink/grow as needed (flex:1 1 auto) so the file list
       claims its share when open. The video element inside is bound
       to 100% of the player — never to viewport — so it cannot push
       siblings off-screen. */
    min-height: 320px;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    background: #000;
    position: relative;
    overflow: hidden;
  }
  .player video, .player audio, .player img {
    width: 100%;
    /* Bound to the player's height (NOT viewport). Was 80vh which
       overflowed the modal when the player got small — pushing the
       file list off-screen on portrait/short windows. */
    max-height: 100%;
    min-height: 0;
    background: #000;
    display: block;
    object-fit: contain;
  }
  .player audio { padding: 30px; max-height: none; min-height: 0; }
  .player img { max-height: 80vh; min-height: 0; }
  .player-msg {
    padding: 60px 40px;
    text-align: center;
    color: var(--green-dim, #4d8a5a);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .player-msg.loading {
    color: var(--amber, #ffb000);
    animation: blink 1.2s steps(2) infinite;
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.5);
  }
  .player-msg.err {
    color: var(--red, #f55);
    text-shadow: 0 0 6px rgba(255, 80, 80, 0.5);
  }
  .transcode-note {
    padding: 6px 12px;
    border-top: 1px solid var(--line, #1d3a26);
    color: var(--amber, #ffb000) !important;
    background: rgba(255, 176, 0, 0.04);
  }

  /* Subtitle / translation bar under the player */
  .subs-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-top: 1px solid var(--line, #1d3a26);
    background: #07120a;
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .sub-btn {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green-dim, #4d8a5a);
    padding: 3px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    border-radius: 999px;
    text-transform: lowercase;
  }
  .sub-btn:hover { color: var(--green, #33ff77); border-color: var(--green-dim, #4d8a5a); }
  .sub-btn.on {
    background: rgba(255, 176, 0, 0.12);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
  }
  .sub-btn-gen {
    background: rgba(77, 208, 225, 0.08);
    border-color: var(--cyan, #4dd0e1);
    color: var(--cyan, #4dd0e1);
  }
  .sub-btn-gen:hover { background: rgba(77, 208, 225, 0.18); }
  .sub-btn-gen:disabled { opacity: 0.5; cursor: not-allowed; }
  .lang-select {
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green, #33ff77);
    padding: 3px 6px;
    font: inherit;
    font-size: 11px;
    border-radius: 2px;
    outline: none;
  }

  /* Stack the <video> + transcribe overlay + custom controls + settings
     so they all sit on top without pushing the video out of layout. */
  .video-stack {
    position: relative;
    line-height: 0;
    background: #000;
  }
  .video-stack.fullscreen { width: 100vw; height: 100vh; }
  .video-stack.controls-hidden { cursor: none; }
  .video-stack.fullscreen video { max-height: 100vh; }

  /* ── Codec-fallback banner: SYSTEM message bar ─────────────
     Looks like a kernel notice — amber-on-black with a `> SYS:`
     prefix. The "spinner" is a horizontal sweep bar (sonar-style)
     instead of a generic round one.                              */
  .codec-fallback-banner {
    position: absolute;
    top: 12px;
    left: 12px;
    right: 12px;
    background: #1a0e00;
    color: var(--amber, #ffb000);
    padding: 9px 14px;
    border-radius: 0;
    border: 1px solid var(--amber, #ffb000);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.05em;
    z-index: 8;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 0 18px rgba(255, 176, 0, 0.35), inset 0 0 30px rgba(255, 176, 0, 0.05);
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.5);
    animation: cfb-fade 220ms ease-out;
  }
  .codec-fallback-banner::before {
    content: "> SYS:";
    color: var(--amber, #ffb000);
    font-weight: 700;
    letter-spacing: 0.12em;
    opacity: 0.7;
  }
  @keyframes cfb-fade { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
  /* Sonar sweep bar — replaces the round spinner. A single phosphor line
     scans left-to-right inside a thin frame.                           */
  .cfb-spinner {
    flex: 0 0 28px;
    width: 28px;
    height: 10px;
    position: relative;
    overflow: hidden;
    border: 1px solid rgba(255, 176, 0, 0.4);
    background: rgba(0, 0, 0, 0.5);
    border-radius: 0;
    animation: none;
  }
  .cfb-spinner::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 3px;
    background: var(--amber, #ffb000);
    box-shadow: 0 0 6px var(--amber, #ffb000);
    animation: sonar-sweep 1.1s linear infinite;
  }
  @keyframes sonar-sweep {
    0%   { transform: translateX(0); opacity: 0.4; }
    50%  { opacity: 1; }
    100% { transform: translateX(28px); opacity: 0.4; }
  }

  /* ── Captions overlay (we render cues ourselves) ─────────────── */
  .captions-overlay {
    position: absolute;
    left: 0; right: 0;
    display: flex;
    justify-content: center;
    align-items: flex-end;
    padding: 0 8%;
    pointer-events: none;
    z-index: 4;
  }
  /* `bottom: 12%` collided with the controls bar on shorter players.
     14% lifts captions a hair above the gradient so the eye reads them
     clean even when controls are visible.                             */
  .captions-overlay.pos-bottom { bottom: 14%; }
  .captions-overlay.pos-top { top: 6%; align-items: flex-start; }
  .captions-text {
    display: inline-block;
    line-height: 1.25;
    padding: 0.15em 0.65em;
    border-radius: 0;          /* CRT consistency — sharp edges */
    text-align: center;
    font-weight: 500;
    max-width: 100%;
    /* Phosphor-glow default. Inline styles override font/size/colour/bg
       per the user's settings; text-shadow inline also wins.            */
    text-shadow:
      0 0 8px rgba(255, 255, 255, 0.45),
      0 1px 0 rgba(0, 0, 0, 0.95),
      0 -1px 0 rgba(0, 0, 0, 0.95),
      1px 0 0 rgba(0, 0, 0, 0.95),
      -1px 0 0 rgba(0, 0, 0, 0.95);
  }
  .caption-line { white-space: pre-wrap; }

  /* ── Custom controls bar ──────────────────────────────────────── */
  .player-controls {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    background:
      linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.65) 55%, transparent 100%);
    padding: 22px 20px 14px;
    z-index: 6;
    opacity: 0;
    transition: opacity 200ms ease-out;
    pointer-events: none;
    /* Faint phosphor underline so the controls feel attached to the bezel */
    border-top: 1px solid transparent;
  }
  .player-controls.visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* Scrub bar — a phosphor track with a tall vertical bar (CRT cursor)
     in place of the round thumb. The track has a subtle inner shadow so
     it reads as a recessed groove on the panel.                       */
  .scrub-row { padding: 0 6px 12px; }
  .scrub {
    width: 100%;
    appearance: none;
    -webkit-appearance: none;
    height: 5px;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.4));
    border: 1px solid rgba(255, 176, 0, 0.18);
    border-radius: 0;
    outline: none;
    cursor: pointer;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.8);
  }
  .scrub::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 4px; height: 16px;
    border-radius: 0;
    background: var(--amber, #ffb000);
    border: none;
    cursor: pointer;
    margin-top: -6px;          /* center on a 5px track */
    box-shadow:
      0 0 6px rgba(255, 176, 0, 0.85),
      0 0 12px rgba(255, 176, 0, 0.45);
  }
  .scrub::-moz-range-thumb {
    width: 4px; height: 16px;
    border-radius: 0;
    background: var(--amber, #ffb000);
    border: none;
    cursor: pointer;
    box-shadow:
      0 0 6px rgba(255, 176, 0, 0.85),
      0 0 12px rgba(255, 176, 0, 0.45);
  }
  .scrub:hover::-webkit-slider-thumb { height: 20px; margin-top: -8px; }
  .scrub:hover::-moz-range-thumb { height: 20px; }
  .scrub:disabled { opacity: 0.35; cursor: not-allowed; }

  .ctrl-row {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-1, #e5e5e5);
    line-height: 1;
  }
  .ctrl-row .spacer { flex: 1; }
  .ctrl-row .time {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    color: var(--green, #33ff77);
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.55);
    margin: 0 8px 0 4px;
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
    padding: 3px 8px;
    border: 1px solid rgba(51, 255, 119, 0.18);
    background: rgba(0, 0, 0, 0.45);
  }
  .ctrl-row .time .dim {
    color: rgba(51, 255, 119, 0.4);
    margin: 0 4px;
    text-shadow: none;
  }
  /* Generic player button — sharp corners, uppercase mono captions for
     text variants, phosphor border-glow on hover, amber active state.   */
  .pc-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-2, #aaa);
    font-size: 13px;
    width: 32px; height: 32px;
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer;
    border-radius: 0;
    transition: background 120ms ease-out, color 120ms ease-out, border-color 120ms, box-shadow 120ms;
    line-height: 1;
  }
  .pc-btn:hover {
    background: rgba(255, 176, 0, 0.06);
    border-color: rgba(255, 176, 0, 0.45);
    color: var(--amber, #ffb000);
    box-shadow: 0 0 8px rgba(255, 176, 0, 0.35), inset 0 0 6px rgba(255, 176, 0, 0.06);
  }
  .pc-btn.on {
    color: var(--amber, #ffb000);
    border-color: rgba(255, 176, 0, 0.55);
    background: rgba(255, 176, 0, 0.08);
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.6);
  }
  .pc-btn.pc-play { font-size: 15px; }
  .pc-btn.rate-btn,
  .pc-btn.cc-btn {
    width: auto;
    padding: 0 10px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.1em;
    font-weight: 600;
    text-transform: uppercase;
    height: 24px;
    align-self: center;
  }
  /* Count pill next to "CC" — green when subs are available so the user
     sees there's something to pick without opening Settings. */
  .pc-btn.cc-btn { display: inline-flex; align-items: center; gap: 5px; position: relative; }
  .cc-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 14px;
    height: 14px;
    padding: 0 4px;
    border-radius: 7px;
    background: rgba(95, 219, 160, 0.18);
    color: #5fdba0;
    border: 1px solid rgba(95, 219, 160, 0.45);
    font: 700 9px/1 'JetBrains Mono', monospace;
    letter-spacing: 0;
    text-transform: none;
    text-shadow: 0 0 4px rgba(95, 219, 160, 0.55);
  }
  .pc-btn.settings-btn,
  .pc-btn.fs-btn,
  .pc-btn.pc-mute,
  .pc-btn.pc-play {
    height: 30px;
    width: 30px;
  }
  /* Settings gear: extra glow when open so the user sees their anchor */
  .pc-btn.settings-btn.on { box-shadow: 0 0 10px rgba(255, 176, 0, 0.55); }

  /* Volume — same recessed-groove style as the scrub track. Hover
     brightens the LED dot so it's easier to grab.                     */
  .volume {
    appearance: none;
    -webkit-appearance: none;
    width: 84px;
    height: 4px;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.4));
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0;
    outline: none;
    cursor: pointer;
    margin-left: 4px;
  }
  .volume::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 4px; height: 12px;
    border-radius: 0;
    background: var(--text-1, #e5e5e5);
    border: none;
    margin-top: -4px;
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.4);
    transition: background 120ms;
  }
  .volume::-moz-range-thumb {
    width: 4px; height: 12px;
    border-radius: 0;
    background: var(--text-1, #e5e5e5);
    border: none;
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.4);
  }
  .volume:hover::-webkit-slider-thumb {
    background: var(--amber, #ffb000);
    box-shadow: 0 0 8px var(--amber, #ffb000);
  }
  .volume:hover::-moz-range-thumb {
    background: var(--amber, #ffb000);
    box-shadow: 0 0 8px var(--amber, #ffb000);
  }

  /* ── Settings popover: side panel with corner brackets ──────
     Sharp 90° corners, recessed body, monospaced tab strip with
     `[ ]` brackets on the active tab. Width nudged up so longer
     translation/engine labels don't wrap awkwardly.              */
  .settings-popover {
    position: absolute;
    /* Bottom-anchored, content-sized. Popover grows UPWARD to fit
       its content, capped by max-height so it never extends past the
       top edge of the video stack. Letting it size to content (instead
       of filling the whole height with top+bottom) means no giant
       empty void below the wizard. */
    right: 18px;
    bottom: 80px;
    width: min(520px, calc(100% - 36px));
    max-height: calc(100% - 120px);
    display: flex;
    flex-direction: column;
    background:
      linear-gradient(180deg, rgba(13, 26, 18, 0.97), rgba(7, 18, 10, 0.97));
    border: 1px solid var(--amber, #ffb000);
    border-radius: 0;
    box-shadow:
      0 10px 36px rgba(0, 0, 0, 0.7),
      0 0 18px rgba(255, 176, 0, 0.22),
      inset 0 0 60px rgba(0, 0, 0, 0.25);
    z-index: 7;
    color: var(--text-1, #e5e5e5);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    animation: settings-in 220ms cubic-bezier(0.16, 1, 0.3, 1);
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  @keyframes settings-in {
    from { transform: translateY(10px) scale(0.98); opacity: 0; }
    to   { transform: translateY(0) scale(1);       opacity: 1; }
  }
  /* Corner brackets — same trick as the modal but smaller and tighter
     to mark the popover as a sub-instrument. */
  .settings-popover::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 8px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 1px 8px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 8px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 1px 8px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 8px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 1px 8px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 8px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 1px 8px no-repeat;
    filter: drop-shadow(0 0 2px rgba(255, 176, 0, 0.7));
  }

  .settings-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid rgba(255, 176, 0, 0.3);
    padding: 0 6px;
    background: linear-gradient(180deg, rgba(255, 176, 0, 0.04), transparent);
    flex-shrink: 0;       /* tabs never collapse — the body absorbs scroll */
  }
  .tab-btn {
    background: transparent;
    border: 0;
    color: var(--green-dim, #4d8a5a);
    padding: 10px 14px 9px;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    position: relative;
    transition: color 100ms;
  }
  .tab-btn:hover { color: var(--green, #33ff77); }
  /* Active tab gets `[ ]` brackets to make the selection unambiguous
     even at small font sizes — a terminal-style emphasis.            */
  .tab-btn.on {
    color: var(--amber, #ffb000);
    border-bottom-color: var(--amber, #ffb000);
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.6);
  }
  .tab-btn.on::before { content: "["; margin-right: 3px; opacity: 0.7; }
  .tab-btn.on::after  { content: "]"; margin-left: 3px; opacity: 0.7; }
  .tab-btn.close-btn {
    color: var(--text-2, #aaa);
    font-size: 18px;
    padding: 6px 12px;
    line-height: 1;
  }
  .tab-btn.close-btn:hover { color: var(--red, #f55); text-shadow: 0 0 6px rgba(255, 80, 80, 0.5); }
  .tab-btn.close-btn::before, .tab-btn.close-btn::after { content: none; }
  .settings-tabs .spacer { flex: 1; }

  .settings-body {
    /* Generous top padding so the first label's text-shadow halo and
       ascenders aren't clipped by the scroll edge. */
    padding: 28px 22px 22px;
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 176, 0, 0.4) transparent;
  }
  .settings-body::-webkit-scrollbar { width: 6px; }
  .settings-body::-webkit-scrollbar-thumb { background: rgba(255, 176, 0, 0.4); border-radius: 0; }
  .settings-body::-webkit-scrollbar-track { background: transparent; }

  .section-head {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--amber, #ffb000);
    padding-bottom: 6px;
    margin: 10px 0 12px;
    font-weight: 700;
    /* ASCII tick-rule underline: solid line with little caps at each end.
       Pure CSS via gradient stripes — no extra DOM.                      */
    background-image:
      linear-gradient(to right, var(--amber, #ffb000) 0, var(--amber, #ffb000) 1px, transparent 1px, transparent calc(100% - 1px), var(--amber, #ffb000) calc(100% - 1px), var(--amber, #ffb000) 100%),
      linear-gradient(to right, rgba(255, 176, 0, 0.4), rgba(255, 176, 0, 0.05));
    background-repeat: no-repeat;
    background-position: bottom, bottom;
    background-size: 100% 6px, 100% 1px;
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.5);
  }

  /* ──────────────────────────────────────────────────────────────────
     SUBTITLE PANEL — single-config flat layout.

     Replaced the 2-step wizard with one stack of labeled config blocks
     and ONE big CTA at the bottom. User picks everything up front,
     clicks once, kernel runs the whole pipeline. Cleaner than wizards
     for a flow that's small but has multiple options.
     ────────────────────────────────────────────────────────────────── */
  .subs-panel { padding: 4px 2px; display: flex; flex-direction: column; gap: 22px; }

  /* Big secondary CTA — "+ Generate new subtitle" — visually clearer
     than a dotted toggle. Lives in SELECT mode to invite the user to
     create more languages. */
  .cta-btn.cta-generate-new {
    margin-top: 4px;
    background: rgba(51, 255, 119, 0.06);
    color: var(--green, #33ff77);
    border: 1px dashed var(--green-dim, #4d8a5a);
    padding: 14px 16px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
    border-radius: 0;
    transition: border-color 120ms, background 120ms, color 120ms, box-shadow 120ms;
  }
  .cta-btn.cta-generate-new:hover {
    border-color: var(--green, #33ff77);
    border-style: solid;
    background: rgba(51, 255, 119, 0.12);
    box-shadow: 0 0 14px rgba(51, 255, 119, 0.2);
  }

  /* Back link in GENERATE mode — small, top-anchored. */
  .back-link {
    align-self: flex-start;
    background: transparent;
    border: 0;
    color: var(--green-dim, #4d8a5a);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 4px 0;
    cursor: pointer;
    transition: color 120ms;
  }
  .back-link:hover { color: var(--green, #33ff77); }

  /* Larger select for the primary "Generate in LANG" picker. */
  .cfg-select.cfg-select-lg {
    width: 100%;
    padding: 12px 14px;
    font-size: 13px;
    background: rgba(0, 0, 0, 0.7);
    border-color: rgba(255, 176, 0, 0.4);
  }
  .cfg-select.cfg-select-lg:hover { border-color: var(--amber, #ffb000); }
  /* Each section gets a clear horizontal divider above its label so the
     SELECT row, the GENERATE collapsible, and the PLAYBACK footer feel
     like distinct zones — not one wall of stacked controls. */
  .cfg-block {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cfg-label {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;             /* bumped from 9px so labels are readable */
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--amber, #ffb000);
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.45);
    padding-bottom: 4px;
    border-bottom: 1px dashed rgba(255, 176, 0, 0.25);
    /* Padding-top + line-height so the text-shadow halo doesn't get
       clipped by the parent's scroll edge. */
    padding-top: 2px;
    line-height: 1.4;
  }
  .cfg-label::before { content: "▸ "; opacity: 0.6; }
  .cfg-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  /* Stack source pills as full-width rows for the SELECT list — each
     option is a clear, tappable row instead of a cramped horizontal
     line of capsules. The Target Language picker overrides this back
     to flex-row via .cfg-row.target-row. */
  .cfg-row.source-row {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .cfg-row.target-row {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 8px;
  }
  /* Compact pills used in horizontal rows (target language) — keep them
     inline-sized, not full-width. */
  .cfg-row.target-row .src-pill {
    width: auto;
    padding: 9px 14px;
  }

  /* Source pill — full-row card with icon + label + optional badge. */
  .src-pill {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
    width: 100%;
    text-align: left;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-1, #e5e5e5);
    cursor: pointer;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    border-radius: 0;
    transition: border-color 120ms, color 120ms, background 120ms, box-shadow 120ms;
  }
  .src-pill:hover {
    color: var(--text-1, #e5e5e5);
    border-color: var(--green-dim, #4d8a5a);
    background: rgba(51, 255, 119, 0.05);
  }
  .src-pill.on {
    background: linear-gradient(135deg, rgba(255, 176, 0, 0.18), rgba(255, 176, 0, 0.04));
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
    box-shadow: inset 3px 0 0 var(--amber, #ffb000), 0 0 10px rgba(255, 176, 0, 0.18);
  }
  .src-icon { font-size: 16px; line-height: 1; flex-shrink: 0; width: 18px; text-align: center; }
  .src-badge {
    display: inline-block;
    margin-left: auto;             /* push to right edge of full-row pill */
    padding: 2px 8px;
    border: 1px solid rgba(77, 208, 225, 0.5);
    background: rgba(77, 208, 225, 0.08);
    color: var(--cyan, #4dd0e1);
    border-radius: 0;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: lowercase;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .src-badge.ready {
    color: var(--green, #33ff77);
    background: rgba(51, 255, 119, 0.12);
    border-color: rgba(51, 255, 119, 0.45);
    text-shadow: 0 0 3px rgba(51, 255, 119, 0.5);
    opacity: 1;
  }
  .src-badge.cached {
    color: var(--cyan, #4dd0e1);
    background: rgba(77, 208, 225, 0.1);
    border-color: rgba(77, 208, 225, 0.4);
    opacity: 1;
  }
  .src-pill .dim { color: var(--green-dim, #4d8a5a); margin-left: 3px; font-weight: 400; }

  /* Generic config select inside a cfg-row */
  .cfg-select {
    flex: 1;
    min-width: 140px;
    background: rgba(0, 0, 0, 0.65);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-1, #e5e5e5);
    padding: 7px 10px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    border-radius: 0;
    outline: none;
    cursor: pointer;
    transition: border-color 120ms, box-shadow 120ms;
  }
  .cfg-select:hover { border-color: var(--green-dim, #4d8a5a); }
  .cfg-select:focus { border-color: var(--amber, #ffb000); box-shadow: 0 0 6px rgba(255, 176, 0, 0.3); }
  .cfg-select:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Advanced collapsible — hides engine-config noise by default. */
  /* Advanced/Engine-settings toggle — borderless inline link, NOT a
     button-rectangle. Just a chevron + label + hint. Looks like a
     section header you can collapse. */
  .adv-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    align-self: flex-start;
    padding: 4px 0;
    background: transparent;
    border: 0;
    color: var(--green-dim, #4d8a5a);
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
    border-radius: 0;
    transition: color 120ms;
  }
  .adv-toggle:hover { color: var(--amber, #ffb000); }
  .adv-toggle.open { color: var(--amber, #ffb000); }
  .adv-caret {
    color: var(--amber, #ffb000);
    font-size: 10px;
    width: 10px;
    text-align: center;
  }
  .adv-label { font-weight: 700; }
  .adv-hint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0.02em;
    font-size: 9.5px;
    color: var(--text-2, #888);
    opacity: 0.85;
  }
  .adv-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    /* No box — just indented contents under the toggle. Less visual
       noise; the toggle's own border already marks the section. */
    padding: 8px 0 0 14px;
    border-left: 1px dashed rgba(255, 176, 0, 0.22);
    margin-left: 6px;
    animation: adv-slide 180ms ease-out;
  }
  @keyframes adv-slide {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* GENERATE toggle / body — visually demoted vs the SELECT row above
     so the user understands SELECT is the primary action. */
  .gen-toggle {
    margin-top: 4px;
    border-color: var(--green-dim, #4d8a5a);
    color: var(--green-dim, #4d8a5a);
  }
  .gen-toggle:hover {
    color: var(--green, #33ff77);
    border-color: var(--green, #33ff77);
    background: rgba(51, 255, 119, 0.04);
  }
  .gen-toggle.open {
    color: var(--green, #33ff77);
    border-color: var(--green, #33ff77);
    background: rgba(51, 255, 119, 0.05);
  }
  .gen-body {
    border-color: rgba(51, 255, 119, 0.22);
    background: linear-gradient(180deg, rgba(51, 255, 119, 0.03), rgba(0, 0, 0, 0.2));
  }

  /* Empty-state hint shown in the SELECT row when nothing's available. */
  .empty-hint {
    padding: 8px 4px;
    font-size: 10px;
    letter-spacing: 0.04em;
    font-style: italic;
  }

  /* Translation engine grid — strict 2 columns, even in narrow popovers */
  .engine-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .engine-tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px 10px 14px;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-2, #aaa);
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    border-radius: 0;
    position: relative;
    transition: border-color 120ms, color 120ms, background 120ms, box-shadow 120ms, transform 120ms;
    /* CRITICAL: grid items default to min-width:auto which means their
       content's intrinsic width pushes the column wider than 1fr — long
       model names like "grok-4-fast-non-reasoning" overflow into the
       neighbour tile and the whole grid looks "encimado". min-width:0
       + overflow:hidden contains the content; the inner spans truncate
       with ellipsis. */
    min-width: 0;
    overflow: hidden;
  }
  /* Truncate long model labels — keep et-name untouched so the [auto]
     badge can still flex inline with the brand name. */
  .et-meta, .et-time {
    display: block;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .et-name {
    max-width: 100%;
    overflow: hidden;
  }
  .engine-tile:hover {
    color: var(--text-1, #e5e5e5);
    border-color: var(--green-dim, #4d8a5a);
    background: rgba(51, 255, 119, 0.04);
    transform: translateY(-1px);
  }
  .engine-tile.on {
    border-color: var(--amber, #ffb000);
    /* Keep the background dark — the amber-on-amber-tint version made
       the brand name and model meta nearly invisible at this size.
       Use a left rail + glow + bright text for the selected state. */
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    box-shadow: inset 5px 0 0 var(--amber, #ffb000), 0 0 14px rgba(255, 176, 0, 0.3);
  }
  .engine-tile.on .et-name {
    color: var(--amber, #ffb000);
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.5);
  }
  .engine-tile.on .et-meta {
    color: #fff;
    opacity: 1;
  }
  .engine-tile.on .et-time {
    color: var(--amber, #ffb000);
    opacity: 0.85;
  }
  .engine-tile.on::after {
    content: "●";
    position: absolute;
    top: 8px;
    right: 10px;
    font-size: 10px;
    color: var(--amber, #ffb000);
    text-shadow: 0 0 6px var(--amber, #ffb000);
  }
  .et-name {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .et-meta {
    font-size: 10px;
    color: var(--green, #33ff77);   /* bumped from green-dim — was illegible */
    letter-spacing: 0.02em;
    opacity: 0.8;
  }
  /* (overridden above for higher contrast) */
  .et-time {
    font-size: 9px;
    color: var(--text-2, #888);
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  /* (overridden above for higher contrast) */
  .et-badge {
    font-size: 7px;
    padding: 1px 4px;
    background: rgba(51, 255, 119, 0.15);
    color: var(--green, #33ff77);
    border: 1px solid rgba(51, 255, 119, 0.5);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    text-shadow: 0 0 3px rgba(51, 255, 119, 0.5);
    font-weight: 700;
  }

  /* Pipeline preview — borderless inline summary. Just the prefix
     glyph + the line. Looks like terminal output, not a card. */
  .pipeline-preview {
    padding: 6px 0 6px 0;
    background: transparent;
    border: 0;
  }
  .pp-label {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--amber, #ffb000);
    margin-bottom: 5px;
    opacity: 0.75;
  }
  .pp-line {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10.5px;
    color: var(--green, #33ff77);
    line-height: 1.6;
    letter-spacing: 0.02em;
    word-break: break-word;
  }
  .pp-line strong { color: var(--amber, #ffb000); font-weight: 700; }
  .pp-step::before { content: "$ "; opacity: 0.5; }
  .pp-arrow {
    color: var(--cyan, #4dd0e1);
    margin: 0 6px;
    font-weight: 700;
    text-shadow: 0 0 3px rgba(77, 208, 225, 0.5);
  }

  /* Apply CTA — primary button, big, amber when ready */
  .cta-btn.cta-apply {
    margin-top: 4px;
    background: linear-gradient(135deg, rgba(255, 176, 0, 0.16), rgba(255, 176, 0, 0.06));
    color: var(--amber, #ffb000);
    border: 1px solid var(--amber, #ffb000);
    padding: 13px 16px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    text-shadow: 0 0 5px rgba(255, 176, 0, 0.5);
    box-shadow: 0 0 16px rgba(255, 176, 0, 0.18);
  }
  .cta-btn.cta-apply:hover:not(:disabled) {
    background: var(--amber, #ffb000);
    color: #1a0e00;
    box-shadow: 0 0 22px rgba(255, 176, 0, 0.55), inset 0 0 14px rgba(255, 255, 255, 0.18);
    text-shadow: none;
  }
  .cta-btn.cta-apply.applied {
    background: linear-gradient(135deg, rgba(51, 255, 119, 0.12), rgba(51, 255, 119, 0.04));
    color: var(--green, #33ff77);
    border-color: var(--green, #33ff77);
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.5);
    box-shadow: 0 0 10px rgba(51, 255, 119, 0.18);
  }
  .cta-btn.cta-apply:disabled {
    background: rgba(255, 176, 0, 0.04);
    color: rgba(255, 176, 0, 0.4);
    border-color: rgba(255, 176, 0, 0.3);
    cursor: not-allowed;
    text-shadow: none;
    box-shadow: none;
  }

  /* ──────────────────────────────────────────────────────────────────
     Legacy wizard (kept as no-op for the now-unused .subs-wizard class).
     ────────────────────────────────────────────────────────────────── */
  /* ──────────────────────────────────────────────────────────────────
     SUBTITLE WIZARD — patch-panel architecture.

     Each section is a self-contained framed module, not items in a list.
     The visual separation comes from CONTAINMENT (boxed panels) rather
     than dividers between siblings. The result reads like rack-mounted
     gear: SOURCE module on top, override toggle as a discrete utility
     strip, DESTINATION (translation) module below.
     ────────────────────────────────────────────────────────────────── */
  .subs-wizard { padding: 0; }

  /* Step panel — recessed dark surface with a thin amber edge. The
     LEFT edge is fatter (gutter for the binder-tab number) and gets
     a subtle vertical glow on the .done state.                      */
  .step {
    position: relative;
    background:
      linear-gradient(180deg, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.35)),
      radial-gradient(ellipse at top left, rgba(255, 176, 0, 0.04), transparent 60%);
    border: 1px solid rgba(255, 176, 0, 0.18);
    padding: 18px 20px 18px 24px;
    margin-bottom: 18px;
    transition: border-color 180ms, box-shadow 180ms;
  }
  .step:last-child { margin-bottom: 0; }
  /* Faint vertical accent on the left gutter — anchors the step-num cell
     visually so it reads as a binder tab attached to the panel.        */
  .step::before {
    content: "";
    position: absolute;
    left: -1px;
    top: 12px;
    bottom: 12px;
    width: 2px;
    background: rgba(77, 138, 90, 0.3);
    transition: background 180ms, box-shadow 180ms;
  }
  .step.done {
    border-color: rgba(255, 176, 0, 0.42);
    box-shadow: 0 0 14px rgba(255, 176, 0, 0.08);
  }
  .step.done::before {
    background: var(--amber, #ffb000);
    box-shadow: 0 0 6px var(--amber, #ffb000);
  }
  .step.disabled {
    opacity: 0.42;
    filter: grayscale(0.5);
    border-style: dashed;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.35));
  }
  .step.disabled::before { background: rgba(77, 138, 90, 0.18); box-shadow: none; }

  /* Step head — number cell on the left, title block on the right. The
     head gets a separator line at its bottom so the body reads as a
     distinct sub-zone within the panel.                                */
  .step-head {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px dashed rgba(77, 138, 90, 0.22);
  }
  .step.done .step-head { border-bottom-color: rgba(255, 176, 0, 0.22); }

  /* Step number — bigger boxed cell that sits visually on top of the
     panel. Uppercase mono numeral with a phosphor glow when active.   */
  .step-num {
    flex: 0 0 32px;
    width: 32px;
    height: 32px;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid var(--green-dim, #4d8a5a);
    color: var(--green-dim, #4d8a5a);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0;
    transition: all 180ms;
    position: relative;
  }
  /* Two corner ticks make it read as a "framed display" instead of
     just a square button. */
  .step-num::before,
  .step-num::after {
    content: "";
    position: absolute;
    width: 4px;
    height: 4px;
    border: 1px solid currentColor;
    opacity: 0.7;
  }
  .step-num::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
  .step-num::after  { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
  .step-num.done {
    background: rgba(255, 176, 0, 0.18);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
    box-shadow:
      0 0 12px rgba(255, 176, 0, 0.5),
      inset 0 0 12px rgba(255, 176, 0, 0.1);
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.8);
  }
  .step-title-block { flex: 1; min-width: 0; padding-top: 4px; }
  .step-title {
    color: var(--text-1, #e5e5e5);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    line-height: 1.2;
  }
  .step.done .step-title { color: var(--amber, #ffb000); text-shadow: 0 0 5px rgba(255, 176, 0, 0.4); }
  .step-tag {
    display: inline-block;
    margin-left: 10px;
    font-size: 9px;
    padding: 2px 7px;
    border-radius: 0;
    background: rgba(77, 208, 225, 0.08);
    color: var(--cyan, #4dd0e1);
    border: 1px solid rgba(77, 208, 225, 0.4);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    vertical-align: 2px;
    font-weight: 700;
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  .step-sub {
    font-size: 10px;
    line-height: 1.5;
    font-family: var(--font-mono, ui-monospace), monospace;
    letter-spacing: 0.04em;
    color: var(--green-dim, #4d8a5a);
  }
  .step-sub::before { content: "// "; opacity: 0.55; }

  /* Step body — choice cards stack inside, no left indent or conduit
     line (the panel boundary already groups them). Comfortable gap. */
  .step-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    position: relative;
  }
  .step-body::before { content: none; }     /* override old conduit */
  .disabled-hint {
    padding: 8px 12px;
    font-style: italic;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--green-dim, #4d8a5a);
    background: rgba(77, 138, 90, 0.06);
    border-left: 2px solid rgba(77, 138, 90, 0.3);
  }
  .disabled-hint::before { content: "▴ "; opacity: 0.7; }

  /* Choice card — patch-bay style. Sharp left rail (4px) on the active
     state for unmissable confirmation. Hover slides a > cursor in
     and lifts the card slightly. Sharp 90° corners, mono throughout. */
  .choice {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 13px 14px 13px 24px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--line, #1d3a26);
    border-radius: 0;
    color: var(--text-2, #aaa);
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    width: 100%;
    position: relative;
    transition: border-color 120ms, background 120ms, color 120ms, transform 120ms, box-shadow 120ms;
  }
  .choice::before {
    content: ">";
    position: absolute;
    left: 9px;
    top: 13px;
    color: var(--green, #33ff77);
    opacity: 0;
    transform: translateX(-4px);
    transition: opacity 120ms, transform 120ms, color 120ms;
    font-weight: 700;
    line-height: 1;
  }
  .choice:hover {
    border-color: var(--green-dim, #4d8a5a);
    color: var(--text-1, #e5e5e5);
    background: rgba(51, 255, 119, 0.05);
  }
  .choice:hover::before { opacity: 0.7; transform: translateX(0); }
  /* Active state — STRONG visual confirmation: 4px amber left rail,
     warm gradient bg, halo glow, and a filled `▸` cursor that matches
     the rail. Impossible to mistake for "not picked".                 */
  .choice.on {
    border-color: var(--amber, #ffb000);
    background:
      linear-gradient(90deg, rgba(255, 176, 0, 0.18) 0%, rgba(255, 176, 0, 0.05) 60%, transparent 100%);
    color: var(--amber, #ffb000);
    box-shadow:
      inset 4px 0 0 var(--amber, #ffb000),
      0 0 14px rgba(255, 176, 0, 0.22),
      inset 0 0 18px rgba(255, 176, 0, 0.06);
  }
  .choice.on::before {
    content: "▸";
    opacity: 1;
    transform: translateX(0);
    color: var(--amber, #ffb000);
    text-shadow: 0 0 6px var(--amber, #ffb000);
    font-size: 13px;
  }
  /* The generate work-card looks distinct (dashed) so it doesn't read
     as "another pick". It's a station you operate, not select.         */
  .choice.generate-card {
    cursor: default;
    border-style: dashed;
    border-color: rgba(77, 208, 225, 0.3);
    padding: 16px 16px 16px 18px;
    background:
      linear-gradient(180deg, rgba(77, 208, 225, 0.04), rgba(0, 0, 0, 0.45));
  }
  .choice.generate-card:hover {
    background: linear-gradient(180deg, rgba(77, 208, 225, 0.04), rgba(0, 0, 0, 0.45));
    color: var(--text-1, #e5e5e5);
    border-color: rgba(77, 208, 225, 0.5);
  }
  .choice.generate-card::before { content: none; }

  .choice-icon {
    flex: 0 0 26px;
    font-size: 18px;
    line-height: 1;
    padding-top: 1px;
    text-align: center;
    filter: drop-shadow(0 0 3px rgba(255, 176, 0, 0.15));
    transition: filter 180ms, transform 180ms;
  }
  .choice.on .choice-icon {
    filter: drop-shadow(0 0 8px rgba(255, 176, 0, 0.7));
    transform: scale(1.05);
  }
  .choice-text { flex: 1; min-width: 0; }
  .choice-title {
    font-size: 12px;
    font-weight: 700;
    line-height: 1.4;
    margin-bottom: 5px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .choice-title .hilite {
    color: var(--cyan, #4dd0e1);
    text-shadow: 0 0 5px rgba(77, 208, 225, 0.45);
  }
  .choice-sub {
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--green-dim, #4d8a5a);
    letter-spacing: 0.02em;
    text-transform: none;
  }
  /* Badges (READY, AUTO, .srt language label) — uniform mono pills
     that align to the title baseline.                              */
  .choice .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 0;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    border: 1px solid;
    line-height: 1.2;
  }
  .badge.ready {
    background: rgba(51, 255, 119, 0.12);
    color: var(--green, #33ff77);
    border-color: rgba(51, 255, 119, 0.5);
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.5);
  }
  .badge.ready::before { content: "✓ "; opacity: 0.85; }
  .badge.cached {
    background: rgba(77, 208, 225, 0.08);
    color: var(--cyan, #4dd0e1);
    border-color: rgba(77, 208, 225, 0.5);
  }

  /* Generate controls — engine/model selectors inside the work-card.
     Two-column flex with mono micro-labels using ASCII tree glyphs.   */
  .generate-controls {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px dashed rgba(77, 208, 225, 0.25);
  }
  .ctl {
    display: flex;
    flex-direction: column;
    gap: 5px;
    flex: 1;
    min-width: 140px;
  }
  .ctl-lbl {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--green-dim, #4d8a5a);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-weight: 700;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .ctl-lbl::before { content: "├ "; opacity: 0.55; }
  .ctl select {
    background: rgba(0, 0, 0, 0.65);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-1, #e5e5e5);
    padding: 6px 9px;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    border-radius: 0;
    outline: none;
    cursor: pointer;
    transition: border-color 120ms, box-shadow 120ms;
  }
  .ctl select:hover { border-color: var(--green-dim, #4d8a5a); }
  .ctl select:focus { border-color: var(--amber, #ffb000); box-shadow: 0 0 6px rgba(255, 176, 0, 0.3); }
  .ctl select:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── ENGINE PICK — the dramatic moment ─────────────────────
     When `.engine-pending` is present (engineConfirmed=false), the
     engine row promotes itself: bigger cards, pulsing border, a
     LOUD banner above announcing "AWAITING SELECTION". After pick,
     the row contracts back to a compact "currently using X" state. */
  .ctl.engine-row {
    width: 100%;
    flex: 0 0 100%;
    margin-top: 6px;
    transition: padding 200ms, background 200ms;
  }
  /* Pending state — uses :has() to detect the pending hint inside
     the same row. Promotes the whole row into the focal point.     */
  .ctl.engine-row:has(.engine-pending) {
    padding: 14px;
    background:
      linear-gradient(180deg, rgba(77, 208, 225, 0.08), rgba(77, 208, 225, 0.02));
    border: 1px solid rgba(77, 208, 225, 0.4);
    box-shadow: inset 0 0 20px rgba(77, 208, 225, 0.04);
  }

  /* Pending-state label transforms into a banner: full-width, sweep
     animation, attention-grabbing.                                  */
  .ctl.engine-row:has(.engine-pending) > .ctl-lbl {
    display: block;
    width: 100%;
    padding: 8px 10px;
    margin-bottom: 12px;
    background: rgba(77, 208, 225, 0.12);
    border: 1px solid var(--cyan, #4dd0e1);
    color: var(--cyan, #4dd0e1);
    font-size: 10px;
    text-align: center;
    text-shadow: 0 0 6px rgba(77, 208, 225, 0.6);
    position: relative;
    overflow: hidden;
  }
  .ctl.engine-row:has(.engine-pending) > .ctl-lbl::before { content: "▸ "; }
  /* Sweep light across the banner */
  .ctl.engine-row:has(.engine-pending) > .ctl-lbl::after {
    content: "";
    position: absolute;
    top: 0; bottom: 0;
    left: -30%;
    width: 30%;
    background: linear-gradient(90deg, transparent, rgba(77, 208, 225, 0.35), transparent);
    animation: engine-sweep 2.4s linear infinite;
  }
  @keyframes engine-sweep {
    from { left: -30%; }
    to   { left: 100%; }
  }

  .engine-pending {
    color: var(--cyan, #4dd0e1);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin-left: 0;
    display: block;
    margin-top: 3px;
    opacity: 0.85;
  }
  .engine-pending::before { content: "└ "; opacity: 0.5; }

  .engine-opts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 10px;
  }

  /* Engine card — larger, with grid layout for consistent height
     across cards no matter how long their meta text is.            */
  .engine-btn {
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-2, #aaa);
    padding: 13px 14px 13px 18px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    border-radius: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
    position: relative;
    transition: border-color 140ms, color 140ms, background 140ms, transform 140ms, box-shadow 140ms;
    min-height: 64px;
  }
  /* When in pending mode, every engine card pulses subtly so the user
     knows interaction is required HERE.                              */
  .ctl.engine-row:has(.engine-pending) .engine-btn {
    border-color: rgba(77, 208, 225, 0.35);
    animation: engine-pulse 2.8s ease-in-out infinite;
  }
  @keyframes engine-pulse {
    0%, 100% { box-shadow: 0 0 0 rgba(77, 208, 225, 0); }
    50%      { box-shadow: 0 0 14px rgba(77, 208, 225, 0.18); }
  }
  .engine-btn:hover {
    color: var(--text-1, #e5e5e5);
    border-color: var(--cyan, #4dd0e1);
    background: rgba(77, 208, 225, 0.06);
    transform: translateY(-1px);
    box-shadow: 0 4px 14px rgba(77, 208, 225, 0.18), 0 0 0 1px rgba(77, 208, 225, 0.3);
    animation: none;
  }
  .engine-btn.on {
    border-color: var(--amber, #ffb000);
    background:
      linear-gradient(135deg, rgba(255, 176, 0, 0.18), rgba(255, 176, 0, 0.04));
    color: var(--amber, #ffb000);
    box-shadow:
      inset 4px 0 0 var(--amber, #ffb000),
      0 0 12px rgba(255, 176, 0, 0.25);
    animation: none;
  }
  /* Selected indicator: a glowing dot that anchors top-right          */
  .engine-btn.on::after {
    content: "●";
    position: absolute;
    top: 11px;
    right: 12px;
    font-size: 11px;
    color: var(--amber, #ffb000);
    text-shadow: 0 0 8px var(--amber, #ffb000);
  }
  .eng-name {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 0;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    line-height: 1.2;
  }
  .eng-badge {
    font-size: 8px;
    padding: 2px 6px;
    background: rgba(51, 255, 119, 0.15);
    color: var(--green, #33ff77);
    border: 1px solid rgba(51, 255, 119, 0.5);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.5);
    font-weight: 700;
  }
  .eng-meta {
    font-size: 10px;
    color: var(--green-dim, #4d8a5a);
    letter-spacing: 0.04em;
    line-height: 1.45;
    text-transform: none;
  }
  .engine-btn.on .eng-meta { color: var(--amber, #ffb000); opacity: 0.78; }

  /* CTA button — primary action ("▶ Start Whisper"). Mono uppercase
     with ASCII brackets via ::before/::after. Cyan command palette. */
  .cta-btn {
    margin-top: 14px;
    background: rgba(77, 208, 225, 0.1);
    color: var(--cyan, #4dd0e1);
    border: 1px solid var(--cyan, #4dd0e1);
    padding: 11px 16px;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    border-radius: 0;
    cursor: pointer;
    width: 100%;
    transition: background 120ms, color 120ms, box-shadow 140ms;
    text-shadow: 0 0 4px rgba(77, 208, 225, 0.5);
    box-shadow: 0 0 0 rgba(77, 208, 225, 0);
  }
  .cta-btn:hover {
    background: var(--cyan, #4dd0e1);
    color: #001b24;
    box-shadow: 0 0 16px rgba(77, 208, 225, 0.6), inset 0 0 12px rgba(255, 255, 255, 0.2);
    text-shadow: none;
  }
  .cta-btn:disabled {
    background: rgba(77, 208, 225, 0.05);
    color: rgba(77, 208, 225, 0.5);
    border-color: rgba(77, 208, 225, 0.3);
    cursor: not-allowed;
    text-shadow: none;
    box-shadow: none;
  }

  /* ── Playback override: utility strip ──────────────────────
     Sits BETWEEN the two wizard steps but visually subordinate —
     a slim cyan-bordered strip with a left rail tag, distinctly
     NOT a wizard step. Reads as "system tweak available" not
     "another decision in the flow".                              */
  /* Force-transcode footer — same hairline-divider language as the
     other section labels. No floating chip, no rectangle, just a
     dim section header above the toggle. */
  .force-transcode-row {
    margin: 14px 0 0 0;
    padding: 14px 0 0 0;
    border-top: 1px dashed rgba(77, 208, 225, 0.25);
    background: transparent;
    position: relative;
  }
  .force-transcode-row::after {
    content: none;
  }
  .force-transcode-row::before {
    content: "▸ PLAYBACK · OVERRIDE";
    display: block;
    margin-bottom: 8px;
    padding: 0;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.2em;
    color: var(--cyan, #4dd0e1);
    background: transparent;
    text-shadow: 0 0 4px rgba(77, 208, 225, 0.45);
  }
  .force-transcode-toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    user-select: none;
  }
  .force-transcode-toggle input[type="checkbox"] {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  /* The knob track: `[OFF | ON]` slot with a single phosphor bar that
     slides between the two slots. No round shapes — this is a console. */
  .ftt-knob {
    flex: 0 0 56px;
    width: 56px;
    height: 22px;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid var(--line, #1d3a26);
    border-radius: 0;
    position: relative;
    transition: border-color 120ms;
    overflow: hidden;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    letter-spacing: 0.1em;
    font-weight: 700;
    color: var(--text-2, #888);
  }
  /* OFF / ON labels baked into the track so they're always visible */
  .ftt-knob::before {
    content: "OFF";
    position: absolute;
    left: 6px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    transition: color 120ms;
  }
  .ftt-knob::after {
    content: "ON";
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    transition: color 120ms;
  }
  /* The travelling phosphor bar — separate element via the input wrapper */
  .ftt-knob > .ftt-bar { display: none; }       /* in case anyone added one */
  .force-transcode-toggle input + .ftt-knob {
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.5);
  }
  /* OFF state highlight */
  .force-transcode-toggle input:not(:checked) + .ftt-knob {
    background:
      linear-gradient(to right, rgba(255, 80, 80, 0.18) 0, rgba(255, 80, 80, 0.18) 28px, rgba(0, 0, 0, 0.7) 28px);
    border-color: rgba(255, 80, 80, 0.5);
  }
  .force-transcode-toggle input:not(:checked) + .ftt-knob::before {
    color: var(--red, #f55);
    text-shadow: 0 0 4px rgba(255, 80, 80, 0.6);
  }
  /* ON state — cyan to harmonize with the utility-strip family.
     Override is always opt-in, so ON should feel "I picked this on
     purpose" not "system-recommended" (that's the amber treatment).  */
  .force-transcode-toggle input:checked + .ftt-knob {
    background:
      linear-gradient(to right, rgba(0, 0, 0, 0.7) 0, rgba(0, 0, 0, 0.7) 28px, rgba(77, 208, 225, 0.25) 28px);
    border-color: var(--cyan, #4dd0e1);
    box-shadow: inset 0 0 8px rgba(77, 208, 225, 0.2), 0 0 8px rgba(77, 208, 225, 0.35);
  }
  .force-transcode-toggle input:checked + .ftt-knob::after {
    color: var(--cyan, #4dd0e1);
    text-shadow: 0 0 5px rgba(77, 208, 225, 0.7);
  }

  .ftt-text { flex: 1; min-width: 0; line-height: 1.45; }
  .ftt-title {
    display: block;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-1, #e5e5e5);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .ftt-sub {
    display: block;
    font-size: 10px;
    margin-top: 3px;
    line-height: 1.45;
    color: var(--green-dim, #4d8a5a);
  }

  /* Inline error — terminal-style with `! ERR:` prefix */
  .inline-err {
    margin-top: 10px;
    padding: 7px 10px;
    border-radius: 0;
    background: rgba(255, 80, 80, 0.08);
    border: 1px solid var(--red, #f55);
    color: #fcc;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    line-height: 1.5;
    letter-spacing: 0.02em;
  }
  .inline-err::before {
    content: "! ERR ";
    color: var(--red, #f55);
    font-weight: 700;
    margin-right: 4px;
    text-shadow: 0 0 4px rgba(255, 80, 80, 0.5);
  }
  .inline-err.global {
    margin: 14px 0 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .dismiss-mini {
    background: transparent;
    border: 0;
    color: #fcc;
    font-size: 16px;
    cursor: pointer;
    margin-left: auto;
    padding: 0 4px;
    line-height: 1;
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  .dismiss-mini:hover { color: var(--red, #f55); }
  .section-head:first-child { margin-top: 0; }
  .section-head .dim { color: var(--green-dim, #4d8a5a); font-weight: 400; text-transform: none; letter-spacing: 0; }
  .row.indent { margin-left: 16px; padding-left: 8px; border-left: 1px solid rgba(77, 138, 90, 0.18); }
  .opt .dim { color: rgba(255, 255, 255, 0.4); margin-left: 4px; font-size: 10px; }
  .settings-body .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
    line-height: 1.3;
  }
  .settings-body .row.preview-row {
    flex-direction: column;
    align-items: stretch;
    background: #000;
    padding: 12px;
    border-radius: 4px;
    margin-top: 6px;
  }
  .settings-body .row.err {
    color: var(--red, #f55);
    font-size: 11px;
  }
  .settings-body .row.dim { color: var(--green-dim, #4d8a5a); }
  .settings-body .row.mini { font-size: 11px; }
  .lbl {
    flex: 0 0 110px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--green-dim, #4d8a5a);
  }
  .val {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    color: var(--green, #33ff77);
    min-width: 48px;
    text-align: right;
  }
  .opts {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    flex: 1;
  }
  .opts.speed-opts { gap: 6px; }
  /* `.opt` pills (used in Style and Speed tabs). Sharp corners,
     mono uppercase, hover phosphor.                              */
  .opt {
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green-dim, #4d8a5a);
    padding: 5px 12px;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 0;
    cursor: pointer;
    transition: color 100ms, border-color 100ms, background 100ms, box-shadow 120ms;
  }
  .opt:hover {
    color: var(--green, #33ff77);
    border-color: var(--green-dim, #4d8a5a);
    background: rgba(51, 255, 119, 0.05);
  }
  .opt.on {
    background: rgba(255, 176, 0, 0.15);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
    box-shadow: 0 0 6px rgba(255, 176, 0, 0.3), inset 0 0 6px rgba(255, 176, 0, 0.05);
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.5);
  }
  .opt.gen {
    background: rgba(77, 208, 225, 0.08);
    border-color: var(--cyan, #4dd0e1);
    color: var(--cyan, #4dd0e1);
  }
  .opt:disabled { opacity: 0.4; cursor: not-allowed; }

  .settings-body .sel {
    flex: 1;
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green, #33ff77);
    padding: 4px 8px;
    font: inherit;
    font-size: 11px;
    border-radius: 3px;
    outline: none;
  }
  .settings-body input[type="range"] {
    flex: 1;
    accent-color: var(--amber, #ffb000);
    cursor: pointer;
  }
  .settings-body input[type="color"] {
    width: 32px;
    height: 24px;
    border: 1px solid var(--line, #1d3a26);
    background: transparent;
    cursor: pointer;
  }

  .caption-preview {
    display: inline-block;
    line-height: 1.25;
    padding: 0.15em 0.6em;
    border-radius: 4px;
    text-align: center;
    align-self: center;
  }

  /* ── Translate progress card: sonar transmission ─────────
     Corner-pinned panel with a sweep-bar that scans across the
     translate-bar — no round spinners. The vibe is "data is
     flowing, watch the line move".                               */
  .translate-card {
    position: absolute;
    bottom: 84px;
    left: 14px;
    width: 340px;
    max-width: calc(100% - 28px);
    background:
      linear-gradient(180deg, rgba(7, 30, 26, 0.97), rgba(4, 18, 16, 0.97));
    border: 1px solid var(--cyan, #4dd0e1);
    border-radius: 0;
    box-shadow:
      0 8px 28px rgba(0, 0, 0, 0.6),
      0 0 18px rgba(77, 208, 225, 0.25),
      inset 0 0 30px rgba(77, 208, 225, 0.04);
    padding: 13px 15px 12px;
    z-index: 6;
    color: var(--text-1, #e5e5e5);
    display: flex;
    align-items: flex-start;
    gap: 12px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    animation: translate-in 240ms cubic-bezier(0.16, 1, 0.3, 1);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
  }
  /* Title-bar accent — corner brackets like the popover */
  .translate-card::before {
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    pointer-events: none;
    background:
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 0 0 / 6px 1px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 0 0 / 1px 6px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 100% 0 / 6px 1px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 100% 0 / 1px 6px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 0 100% / 6px 1px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 0 100% / 1px 6px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 100% 100% / 6px 1px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 100% 100% / 1px 6px no-repeat;
    filter: drop-shadow(0 0 2px rgba(77, 208, 225, 0.6));
  }
  @keyframes translate-in {
    from { transform: translateY(10px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
  /* Sweeping vertical bar inside a thin frame — replaces the round
     CSS spinner. Reads as "scanning…" rather than "loading…".       */
  .translate-spinner {
    width: 22px;
    height: 32px;
    flex: 0 0 22px;
    border-radius: 0;
    border: 1px solid rgba(77, 208, 225, 0.4);
    background: rgba(0, 0, 0, 0.55);
    position: relative;
    overflow: hidden;
    animation: none;
    margin-top: 2px;
  }
  .translate-spinner::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: 3px;
    top: -3px;
    background: var(--cyan, #4dd0e1);
    box-shadow: 0 0 8px var(--cyan, #4dd0e1), 0 0 16px var(--cyan, #4dd0e1);
    animation: sonar-vsweep 1.4s ease-in-out infinite;
  }
  /* Phosphor afterglow trail */
  .translate-spinner::after {
    content: "";
    position: absolute;
    left: 0; right: 0; top: 0; bottom: 0;
    background: linear-gradient(180deg, transparent, rgba(77, 208, 225, 0.08), transparent);
    pointer-events: none;
  }
  @keyframes sonar-vsweep {
    0%   { transform: translateY(0); opacity: 0.6; }
    50%  { opacity: 1; }
    100% { transform: translateY(35px); opacity: 0.4; }
  }
  .translate-body { flex: 1; min-width: 0; }
  .translate-title {
    color: var(--cyan, #4dd0e1);
    font-weight: 700;
    margin-bottom: 6px;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    text-shadow: 0 0 5px rgba(77, 208, 225, 0.5);
  }
  .translate-title::before {
    content: "▸ ";
    opacity: 0.7;
  }
  .translate-meta {
    color: var(--green-dim, #4d8a5a);
    font-size: 10px;
    margin-bottom: 9px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    letter-spacing: 0.04em;
  }
  .translate-meta .kbd {
    padding: 1px 6px;
    border: 1px solid rgba(77, 208, 225, 0.4);
    border-radius: 0;
    background: rgba(77, 208, 225, 0.08);
    color: var(--cyan, #4dd0e1);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .translate-meta strong {
    color: var(--text-1, #e5e5e5);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .translate-bar {
    position: relative;
    height: 5px;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(77, 208, 225, 0.2);
    border-radius: 0;
    overflow: hidden;
  }
  .translate-bar-fill {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgba(77, 208, 225, 0.85), var(--cyan, #4dd0e1));
    transition: width 280ms ease-out;
    box-shadow: 0 0 6px rgba(77, 208, 225, 0.7);
  }
  .translate-bar-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 0%, rgba(255,255,255,0.22) 50%, transparent 100%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
    pointer-events: none;
  }

  /* ── Translate error banner ───────────────────────────────
     Same corner-pinned slot as the progress card, but red-on-
     black with `! ERR:` prefix. Mono so it reads as "console
     output", not a generic alert.                              */
  .translate-error {
    position: absolute;
    bottom: 84px;
    left: 14px;
    width: 380px;
    max-width: calc(100% - 28px);
    background: linear-gradient(180deg, rgba(40, 14, 14, 0.97), rgba(28, 8, 8, 0.97));
    border: 1px solid var(--red, #f55);
    border-radius: 0;
    padding: 11px 14px;
    z-index: 6;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    color: #fcc;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    line-height: 1.45;
    letter-spacing: 0.02em;
    animation: translate-in 220ms ease-out;
    box-shadow: 0 6px 24px rgba(0,0,0,0.6), 0 0 14px rgba(255, 80, 80, 0.25);
  }
  .t-err-icon {
    color: var(--red, #f55);
    font-size: 16px;
    line-height: 1;
    text-shadow: 0 0 6px rgba(255, 80, 80, 0.7);
    margin-top: 1px;
  }
  .t-err-body { flex: 1; min-width: 0; }
  .t-err-body strong {
    color: var(--red, #f55);
    display: block;
    margin-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 10px;
    font-weight: 700;
    text-shadow: 0 0 4px rgba(255, 80, 80, 0.5);
  }
  .t-err-body strong::before { content: "! "; opacity: 0.8; }
  .t-err-dismiss {
    background: transparent;
    border: 0;
    color: #fcc;
    font-size: 16px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  .t-err-dismiss:hover { color: var(--red, #f55); text-shadow: 0 0 4px var(--red, #f55); }

  .cache-hint {
    color: var(--cyan, #4dd0e1);
    font-size: 10px;
    padding: 2px 7px;
    border: 1px dashed rgba(77, 208, 225, 0.45);
    border-radius: 0;
    cursor: help;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* ── Transcribe overlay: big center work-card ──────────────
     Whisper takes minutes; this is the dominant on-screen UI
     while it runs. Dramatic vignette + corner-bracketed work-
     card + multi-bar phosphor scanner so the wait feels
     intentional rather than abandoned.                          */
  .transcribe-overlay {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(0, 4, 1, 0.65) 0%, rgba(0, 0, 0, 0.92) 100%);
    backdrop-filter: blur(5px);
    -webkit-backdrop-filter: blur(5px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5;
    pointer-events: auto;
    animation: overlay-fade-in 240ms ease-out;
  }
  @keyframes overlay-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .transcribe-card {
    position: relative;
    background:
      linear-gradient(180deg, rgba(13, 26, 18, 0.96), rgba(7, 18, 10, 0.96));
    border: 1px solid var(--amber, #ffb000);
    border-radius: 0;
    box-shadow:
      0 0 40px rgba(255, 176, 0, 0.22),
      0 0 1px rgba(255, 176, 0, 0.5),
      inset 0 0 60px rgba(0, 0, 0, 0.4);
    padding: 28px 36px 22px;
    min-width: 360px;
    max-width: 80%;
    text-align: center;
    color: var(--text-1, #e5e5e5);
    font-family: var(--font-mono, ui-monospace), monospace;
    line-height: 1.5;
    transition: border-color 320ms, box-shadow 320ms, background 320ms;
  }
  /* Visual differentiation when modal swaps to translate phase: shift
     border + glow from amber to cyan so the user notices the change. */
  .transcribe-card.translating {
    border-color: var(--cyan, #4dd0e1);
    box-shadow:
      0 0 40px rgba(77, 208, 225, 0.22),
      0 0 1px rgba(77, 208, 225, 0.5),
      inset 0 0 60px rgba(0, 0, 0, 0.4);
  }
  .transcribe-card.translating .transcribe-title {
    color: var(--cyan, #4dd0e1);
    text-shadow: 0 0 8px rgba(77, 208, 225, 0.5);
  }
  .transcribe-card.translating .transcribe-bar-fill {
    background: linear-gradient(90deg, var(--cyan, #4dd0e1), #88e8f5);
  }
  /* Same corner-bracket pattern as other framed instruments */
  .transcribe-card::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 12px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 1px 12px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 12px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 1px 12px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 12px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 1px 12px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 12px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 1px 12px no-repeat;
    filter: drop-shadow(0 0 3px rgba(255, 176, 0, 0.6));
  }
  /* The 4 bouncing bars — keep the original spinner shape but
     tighter, and add an extra tall central bar so it reads as
     "spectrum analyzer" instead of "loading dots".              */
  .transcribe-spinner {
    display: inline-flex;
    gap: 5px;
    margin-bottom: 18px;
    align-items: flex-end;
    height: 22px;
  }
  .transcribe-spinner span {
    display: block;
    width: 5px;
    height: 22px;
    background: var(--amber, #ffb000);
    border-radius: 0;
    box-shadow: 0 0 6px rgba(255, 176, 0, 0.7);
    animation: spinner-bar 0.9s ease-in-out infinite;
  }
  .transcribe-spinner span:nth-child(2) { animation-delay: 0.12s; }
  .transcribe-spinner span:nth-child(3) { animation-delay: 0.24s; }
  .transcribe-spinner span:nth-child(4) { animation-delay: 0.36s; }
  @keyframes spinner-bar {
    0%, 100% { transform: scaleY(0.3); opacity: 0.55; }
    50%      { transform: scaleY(1.0); opacity: 1; }
  }

  .transcribe-title {
    color: var(--amber, #ffb000);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin-bottom: 10px;
    text-shadow: 0 0 8px rgba(255, 176, 0, 0.6);
  }
  .transcribe-title::before { content: "▸ "; opacity: 0.7; }
  .transcribe-meta {
    font-size: 11px;
    margin-bottom: 16px;
    color: var(--green-dim, #4d8a5a);
    letter-spacing: 0.04em;
  }
  .transcribe-meta .kbd {
    display: inline-block;
    padding: 2px 7px;
    border: 1px solid rgba(255, 176, 0, 0.4);
    border-radius: 0;
    background: rgba(255, 176, 0, 0.08);
    color: var(--amber, #ffb000);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .transcribe-bar {
    position: relative;
    height: 7px;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 176, 0, 0.25);
    border-radius: 0;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .transcribe-bar-fill {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgba(255, 176, 0, 0.85), #ffd76b);
    transition: width 280ms ease-out;
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.65);
  }
  .transcribe-bar-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      100deg,
      transparent 0%,
      rgba(255, 255, 255, 0.22) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
    pointer-events: none;
  }
  @keyframes shimmer {
    from { background-position: -100% 0; }
    to   { background-position:  100% 0; }
  }
  /* Indeterminate mode — a thin glow scrubs left↔right inside an otherwise
     empty bar. Used while we haven't received the first real progress tick
     so the user sees the system is alive instead of a stuck-at-100% bar. */
  .transcribe-bar.indeterminate {
    background: rgba(0, 0, 0, 0.6);
  }
  .transcribe-bar.indeterminate::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 32%;
    background: linear-gradient(90deg, transparent, rgba(255, 176, 0, 0.85) 50%, transparent);
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.55);
    animation: transcribe-indet 1.4s ease-in-out infinite;
  }
  @keyframes transcribe-indet {
    0%   { left: -32%; }
    100% { left: 100%; }
  }

  .transcribe-time {
    font-size: 11px;
    color: var(--green-dim, #4d8a5a);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
  }
  .transcribe-time strong {
    color: var(--green, #33ff77);
    font-weight: 700;
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.5);
  }
  /* Percent badge inside .transcribe-meta — sits next to engine/model so
     the user gets a top-of-bar progress reading without scanning down. */
  .meta-pct {
    color: var(--amber, #ffb000);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  /* Stats grid — two labelled chips. AUDIO (what whisper sees) and CLOCK
     (what the user waits). Distinct icons and colour so they can never be
     read as the same value. */
  .transcribe-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-bottom: 10px;
    font-variant-numeric: tabular-nums;
  }
  .ts-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid rgba(255, 176, 0, 0.18);
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.45);
    font: 600 11px 'JetBrains Mono', monospace;
    letter-spacing: 0.02em;
  }
  .ts-ico { font-size: 12px; opacity: 0.85; }
  .ts-lbl {
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.6px;
    color: var(--green-dim, #4d8a5a);
    font-weight: 600;
  }
  .ts-chip strong { color: var(--green, #33ff77); font-weight: 700; }
  .ts-chip .ts-rate,
  .ts-chip .ts-eta {
    color: #b0c8b8;
    font-weight: 500;
    font-size: 10px;
    padding-left: 4px;
    border-left: 1px dashed rgba(176, 200, 184, 0.25);
    margin-left: 2px;
  }
  /* AUDIO chip — green family (what whisper sees) */
  .ts-audio {
    border-color: rgba(95, 219, 160, 0.30);
    background: rgba(95, 219, 160, 0.06);
  }
  .ts-audio .ts-lbl { color: #5fdba0; }
  .ts-audio strong  { color: #5fdba0; text-shadow: 0 0 4px rgba(95, 219, 160, 0.45); }
  /* CLOCK chip — amber family (what the user waits) */
  .ts-clock {
    border-color: rgba(255, 176, 0, 0.30);
    background: rgba(255, 176, 0, 0.06);
  }
  .ts-clock .ts-lbl { color: var(--amber, #ffb000); }
  .ts-clock strong  { color: var(--amber, #ffb000); text-shadow: 0 0 4px rgba(255, 176, 0, 0.45); }
  /* CUES chip (translate phase) */
  .ts-cues {
    border-color: rgba(106, 160, 255, 0.30);
    background: rgba(106, 160, 255, 0.06);
  }
  .ts-cues .ts-lbl { color: #6aa0ff; }
  .ts-cues strong  { color: #6aa0ff; text-shadow: 0 0 4px rgba(106, 160, 255, 0.45); }
  /* DOWNLOAD chip (model-fetch phase) */
  .ts-download {
    border-color: rgba(167, 139, 250, 0.30);
    background: rgba(167, 139, 250, 0.06);
  }
  .ts-download .ts-lbl { color: #a78bfa; }
  .ts-download strong  { color: #a78bfa; text-shadow: 0 0 4px rgba(167, 139, 250, 0.45); }
  .transcribe-hint {
    margin-top: 6px;
    margin-bottom: 14px;
    font-size: 10px;
    letter-spacing: 0.02em;
    color: var(--green-dim, #4d8a5a);
    font-style: italic;
  }
  .transcribe-cancel {
    margin-top: 4px;
    background: transparent;
    border: 1px solid var(--red, #f55);
    color: var(--red, #f55);
    padding: 7px 18px;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    border-radius: 0;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-weight: 700;
    transition: background 120ms, color 120ms, box-shadow 140ms;
  }
  .transcribe-cancel:hover {
    background: var(--red, #f55);
    color: #1a0000;
    box-shadow: 0 0 14px rgba(255, 80, 80, 0.6);
  }

  /* Success toast — `[OK] subtitles ready · 568 cues` mono pill */
  .transcribe-toast {
    position: absolute;
    top: 14px;
    right: 14px;
    background: rgba(7, 30, 14, 0.96);
    border: 1px solid var(--green, #33ff77);
    color: var(--green, #33ff77);
    padding: 7px 12px;
    border-radius: 0;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    z-index: 5;
    box-shadow: 0 0 18px rgba(51, 255, 119, 0.35), inset 0 0 12px rgba(51, 255, 119, 0.05);
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.6);
    animation: toast-in 0.35s ease-out, toast-out 0.5s ease-in 4s forwards;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .transcribe-toast .check {
    background: var(--green, #33ff77);
    color: #001a08;
    width: 16px;
    height: 16px;
    border-radius: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 11px;
    box-shadow: 0 0 6px rgba(51, 255, 119, 0.5);
  }
  @keyframes toast-in {
    from { transform: translateY(-12px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
  @keyframes toast-out {
    to { transform: translateY(-12px); opacity: 0; }
  }

  /* ── File list: directory listing aesthetic ────────────────
     Mono everything, fixed columns, ASCII tree-like header,
     hover slides a `▸` cursor in from the left rail.            */
  .filelist-bottom {
    border-top: 1px solid var(--amber, #ffb000);
    background:
      linear-gradient(180deg, rgba(255, 176, 0, 0.04), transparent 30%),
      #060e09;
    padding: 16px 20px 18px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 280px;            /* enough to show 6-8 file rows */
    max-height: 60vh;             /* up from 220px — give it real room */
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  .filelist-head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0 8px;
    flex-shrink: 0;
  }
  .filelist-head {
    color: var(--amber, #ffb000);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 700;
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.4);
  }
  .filelist-head::before { content: "▸ /"; opacity: 0.7; }
  .filelist-close {
    background: transparent;
    border: 0;
    color: var(--text-2, #888);
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    cursor: pointer;
    transition: color 120ms;
  }
  .filelist-close:hover { color: var(--red, #f55); }
  .filelist-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 176, 0, 0.4) transparent;
  }
  .filelist-row::-webkit-scrollbar { width: 6px; }
  .filelist-row::-webkit-scrollbar-thumb { background: rgba(255, 176, 0, 0.4); border-radius: 0; }
  .filelist-row::-webkit-scrollbar-track { background: transparent; }
  .file-row {
    display: grid;
    grid-template-columns: 12px 26px 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 9px 14px 9px 8px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--green-dim, #4d8a5a);
    cursor: pointer;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    letter-spacing: 0.02em;
    text-align: left;
    border-radius: 0;
    width: 100%;
    position: relative;
    transition: background 90ms, color 90ms, border-color 90ms;
  }
  /* The cursor character before each row — invisible by default,
     slides in on hover/active so the list reads like a directory
     navigation tree.                                              */
  .file-row::before {
    content: "·";
    color: rgba(77, 138, 90, 0.4);
    font-weight: 700;
    transition: color 90ms, content 0ms;
    grid-column: 1;
  }
  .file-row:hover {
    color: var(--green, #33ff77);
    background: rgba(51, 255, 119, 0.05);
    border-color: rgba(51, 255, 119, 0.2);
  }
  .file-row:hover::before { content: "▸"; color: var(--green, #33ff77); }
  .file-row.on {
    background: linear-gradient(90deg, rgba(255, 176, 0, 0.18), rgba(255, 176, 0, 0.04));
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
    box-shadow: inset 3px 0 0 var(--amber, #ffb000), 0 0 8px rgba(255, 176, 0, 0.2);
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.4);
  }
  .file-row.on::before {
    content: "▶";
    color: var(--amber, #ffb000);
    text-shadow: 0 0 5px rgba(255, 176, 0, 0.7);
  }
  .file-row .kind {
    width: 26px;
    height: 18px;
    line-height: 16px;
    text-align: center;
    border: 1px solid var(--line, #1d3a26);
    background: rgba(0, 0, 0, 0.45);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--green-dim, #4d8a5a);
    text-transform: uppercase;
  }
  .file-row .kind-video { color: var(--amber, #ffb000); border-color: rgba(255, 176, 0, 0.5); }
  .file-row .kind-audio { color: var(--cyan, #4dd0e1); border-color: rgba(77, 208, 225, 0.5); }
  .file-row .kind-image { color: #b4ec51; border-color: rgba(180, 236, 81, 0.5); }
  .file-row .fname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    font-size: 11px;
    letter-spacing: 0.02em;
  }
  .file-row .dim.mini {
    color: var(--green-dim, #4d8a5a);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    letter-spacing: 0.04em;
  }
  .file-row.on .dim.mini { color: var(--amber, #ffb000); opacity: 0.7; }

  /* Description panel — opt-in, slides up from the bottom of the modal
     when the user clicks ⓘ INFO in the header. NOT visible by default
     (was sitting below the player as permanent visual noise).         */
  .modal-desc {
    border-top: 1px solid rgba(77, 208, 225, 0.4);
    background:
      linear-gradient(180deg, rgba(77, 208, 225, 0.06), rgba(0, 0, 0, 0.5));
    color: var(--text-1, #e5e5e5);
    font-family: var(--font-mono, ui-monospace), monospace;
    animation: desc-slide-up 240ms cubic-bezier(0.16, 1, 0.3, 1);
    flex-shrink: 0;
  }
  @keyframes desc-slide-up {
    from { transform: translateY(8px); opacity: 0; max-height: 0; }
    to   { transform: translateY(0);   opacity: 1; max-height: 240px; }
  }
  .modal-desc-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 18px;
    border-bottom: 1px dashed rgba(77, 208, 225, 0.25);
    background: rgba(77, 208, 225, 0.04);
  }
  .modal-desc-label {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--cyan, #4dd0e1);
    text-shadow: 0 0 4px rgba(77, 208, 225, 0.45);
  }
  .modal-desc-head .spacer { flex: 1; }
  .modal-desc-close {
    background: transparent;
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-2, #aaa);
    width: 24px; height: 22px;
    line-height: 1;
    cursor: pointer;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 14px;
    border-radius: 0;
    transition: color 100ms, border-color 100ms;
  }
  .modal-desc-close:hover {
    color: var(--red, #f55);
    border-color: var(--red, #f55);
    text-shadow: 0 0 4px rgba(255, 80, 80, 0.5);
  }
  .modal-desc-body {
    padding: 14px 18px 16px;
    color: var(--text-2, #c0c8c4);
    font-size: 12px;
    line-height: 1.6;
    max-height: 200px;
    overflow-y: auto;
    letter-spacing: 0.01em;
    scrollbar-width: thin;
    scrollbar-color: rgba(77, 208, 225, 0.4) transparent;
  }
  .modal-desc-body::-webkit-scrollbar { width: 5px; }
  .modal-desc-body::-webkit-scrollbar-thumb { background: rgba(77, 208, 225, 0.4); border-radius: 0; }

  /* Info button in the header — gets a cyan tint when open */
  .modal-head button.ghost.on {
    color: var(--cyan, #4dd0e1);
    border-color: var(--cyan, #4dd0e1);
    background: rgba(77, 208, 225, 0.08);
    box-shadow: 0 0 6px rgba(77, 208, 225, 0.3), inset 0 0 6px rgba(77, 208, 225, 0.06);
    text-shadow: 0 0 4px rgba(77, 208, 225, 0.5);
  }

  .hover-desc {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(5, 8, 7, 0.92), rgba(5, 8, 7, 0.96));
    color: var(--green, #33ff77);
    padding: 14px 14px 70px;
    overflow: hidden;
    font-size: 11.5px;
    line-height: 1.5;
    pointer-events: none;
    animation: fade 0.18s ease-out;
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .hover-desc p { margin: 0 0 8px; color: #c0e8cd; }
  .hover-desc .tags { display: flex; gap: 5px; flex-wrap: wrap; }
  .hover-desc .tag {
    color: var(--cyan, #4dd0e1);
    font-size: 10px;
    background: rgba(77, 208, 225, 0.08);
    padding: 1px 6px;
    border-radius: 999px;
  }

  .empty {
    grid-column: 1 / -1;
    padding: 60px 20px;
    text-align: center;
    color: var(--green-dim, #4d8a5a);
    font-size: 13px;
  }
  .empty.loading { color: var(--amber, #ffb000); animation: blink 1.2s steps(2) infinite; }

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
    .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); padding: 10px; gap: 8px; }
    .hero, .filters { padding-left: 14px; padding-right: 14px; }
  }
</style>
