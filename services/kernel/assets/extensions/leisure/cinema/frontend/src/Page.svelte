<script lang="ts">
  /*
    /cinema — archive.org movie importer with poster-driven UI.

    Each item from archive.org has a canonical thumbnail at
    `https://archive.org/services/img/<identifier>` — we use it as the card
    background. Cards fade-in lazy, support hover zoom + selection toggle,
    and bulk import via the /api/cinema/media/import-archive/run endpoint.
  */
  import { onMount, onDestroy, tick } from 'svelte';
  // The filters panel opens by pushing the bands below it down rather than
  // floating over the grid. A popover would have covered the posters the
  // filters are there to change, which is the one thing you need to watch
  // while changing them.
  import { slide } from 'svelte/transition';
  // Framework-level motion — the part of "looks expensive" that CSS alone
  // cannot do. When a filter changes the result set, the cards that survive
  // SLIDE to their new positions instead of the grid snapping to a different
  // arrangement. The each-block is already keyed by identifier, which is the
  // prerequisite that makes it possible.
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import type { ExtPageContext } from './types.js';
  // Cue parsing, cue installation and caption styling are shared with /tv and
  // /torrents — this page used to carry its own copies of all three.
  import {
    parseVtt as parseVttShared, installCues,
    SubsController, type SubsAdapter, type SubTrack, type SubsJobStatus,
  } from '$shared/media/subs-client';
  import KernlPlayer from '$shared/media/KernlPlayer.svelte';
  import {
    loadCaptionStyle, saveCaptionStyle, captionInlineStyle as capStyleOf,
    CAPTION_FAMILIES as SHARED_FAMILIES,
    type CaptionStyle,
  } from '$shared/media/caption-style';
  // One icon family for the whole page. The emoji these replaced rendered
  // from a different font on every platform and carried their own colour, so
  // a "dim" chip still had a full-saturation 📁 sitting in it.
  import Icon from '$shared/components/Icon.svelte';
  import { createI18n } from '$shared/i18n';
  import { dicts, CONTENT_LANGUAGES, languageName } from './i18n/index.js';

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
    /**
     * Uploads of this film folded into this row. Present only on collapsed
     * queries; 1 means this is the only copy. When >1, `downloads` and the
     * rating on this row are the work's totals, not this copy's share.
     */
    copies?: number;
    /**
     * What the item actually holds, probed from archive.org's metadata
     * endpoint. Null means nobody has looked inside yet — which is NOT the
     * same as an item that was probed and found empty, and the card has to
     * tell those apart.
     */
    media?: {
      duration_sec: number;
      width: number;
      height: number;
      has_video: boolean;
      has_streamable: boolean;
      has_subtitles: boolean;
      best_format: string;
      probed_at: string;
    } | null;
    /**
     * The catalogued work this upload was identified as, when it was
     * identified at all. Null for the long tail — which means "unknown",
     * not "junk": the archive's industrial and educational cinema is
     * legitimate material that simply is not catalogued as works.
     */
    canonical?: {
      qid: string;
      label: string;
      year: number;
      director: string;
      country: string;
      imdb_id: string;
      /** Already on the catalogue's 0..5 scale. 0 when nobody has rated it. */
      ext_rating: number;
      ext_votes: number;
    } | null;
    /** Curated lists this work is on, as canon rail keys. */
    canon?: string[];
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
  let canonRails: Array<{ key: string; label: string; blurb: string; members: number; held: number }> = [];
  let activeRail = '';

  // ── Discovery from the vectors ───────────────────────────────
  // Neither of these depends on canonical identification, which is why they
  // reach the 81 cartoons Wikidata ignores — the most-downloaded material in
  // this catalogue and invisible to every other quality signal here.
  let similarItems: ArchiveItem[] = [];
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
      if (playItem?.identifier === identifier) similarItems = body.items ?? [];
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
      const r = await apiFetch('/api/cinema/for-you?limit=48');
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `http ${r.status}`);
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
  // The film being filed, not just its id: the dialog shows what you are
  // filing. The old popover covered the card it opened on, so the one thing
  // you needed to see — which film this is — was the thing it hid.
  let dirPickerItem: ArchiveItem | null = null;
  let dirPopoverBusy = false;
  let dirPopoverNotice = '';
  // Inline creation. The empty state used to be a link to another page,
  // which meant discovering you had no directories cost you the film you
  // were trying to file. Now the first directory is made right here.
  let dirNewTitle = '';
  let dirCreating = false;

  // The film whose description is open for reading.
  //
  // The hover overlay is a glance, not a read: 11.5px, clipped to the poster,
  // pointer-events off, so it cannot be scrolled or selected and a long
  // synopsis simply disappears past the bottom edge. This is the read.
  let infoItem: ArchiveItem | null = null;
  function openInfo(item: ArchiveItem, ev: Event) {
    ev.stopPropagation();
    infoItem = item;
    descShowFull = false;
    descLang = '';
    descErr = '';
  }
  function closeInfo() { infoItem = null; }

  // ── Synopsis: translate + expand ────────────────────────────────────
  //
  // archive.org descriptions are almost always English, and long ones were
  // both cut at 1200 characters with no way to see the rest and unreadable to
  // anyone who does not read English. Both are the same problem: the text is
  // there, the UI just would not give it to you.
  //
  // Translation goes through /api/llm/chat, the kernel's one door to the model
  // chain — no bespoke endpoint, and it inherits provider fallback, the rate
  // limiter and the call log for free.
  let descLang = '';           // '' = original
  let descBusy = false;
  let descErr = '';
  let descShowFull = false;
  let descModel = '';
  /** key: `${identifier}:${lang}` — a translation costs tokens; buy it once. */
  const descCache = new Map<string, string>();

  const DESC_LANGS = [
    { code: 'es', label: 'español' },
    { code: 'en', label: 'english' },
    { code: 'pt', label: 'português' },
    { code: 'fr', label: 'français' },
    { code: 'de', label: 'deutsch' },
    { code: 'it', label: 'italiano' },
  ];
  let descTarget = 'es';

  /** What the synopsis paragraph should render right now. */
  $: descSource = infoItem?.description ?? '';
  $: descShown = descLang && infoItem
    ? (descCache.get(`${infoItem.identifier}:${descLang}`) ?? descSource)
    : descSource;
  /** Long ones stay collapsed until asked — see `.info-desc.clamped`. */
  $: descIsLong = descShown.length > 700;

  async function translateDescription(): Promise<void> {
    if (!infoItem || descBusy) return;
    const item = infoItem;
    const key = `${item.identifier}:${descTarget}`;
    if (descCache.has(key)) { descLang = descTarget; return; }
    if (!item.description) return;

    descBusy = true;
    descErr = '';
    try {
      const target = DESC_LANGS.find((l) => l.code === descTarget)?.label ?? descTarget;
      const r = await apiFetch('/api/llm/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system:
            'You translate film synopses. Return ONLY the translated text: no preamble, ' +
            'no notes, no quotes around it, and no explanation of what you did. Preserve ' +
            'proper nouns, film titles and character names. Keep the paragraph structure.',
          user: `Translate this film synopsis into ${target}:\n\n${item.description}`,
          temperature: 0.2,
          maxTokens: Math.max(400, Math.round(item.description.length / 2)),
          caller: 'cinema:describe-translate',
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        throw new Error(e?.error ?? `http ${r.status}`);
      }
      const j = await r.json();
      const text = String(j?.text ?? '').trim();
      if (!text) throw new Error('el modelo devolvió una respuesta vacía');
      descCache.set(key, text);
      descModel = String(j?.model ?? '');
      descLang = descTarget;
      descShowFull = true;   // you asked to read it — don't make it a second click
    } catch (err) {
      descErr = err instanceof Error ? err.message : String(err);
    } finally {
      descBusy = false;
    }
  }
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
  async function openDirPicker(item: ArchiveItem, ev: Event) {
    ev.stopPropagation();
    dirPopoverNotice = '';
    dirNewTitle = '';
    dirPickerItem = dirPickerItem?.identifier === item.identifier ? null : item;
    if (dirPickerItem) await ensureMyDirsLoaded();
  }

  /**
   * Create a directory and drop this film into it, in one go.
   *
   * The two steps are one intention — nobody opens this dialog wanting an
   * empty directory — so splitting them across two screens was the whole
   * problem with the old flow.
   */
  async function createDirAndAdd() {
    const title = dirNewTitle.trim();
    const item = dirPickerItem;
    if (!title || !item) return;
    dirCreating = true;
    dirPopoverNotice = '';
    try {
      const r = await apiFetch('/api/cinema/directories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          description: '',
          category: '',
          cover_identifier: item.identifier,
          visibility: 'private',
          collaborators: [],
        }),
      });
      const body = await r.json().catch(() => ({} as any));
      if (!r.ok) {
        dirPopoverNotice = `✗ ${body.error ?? 'no se pudo crear'}`;
        return;
      }
      const id = body.directory?.id ?? body.id;
      if (!id) {
        dirPopoverNotice = '✗ el servidor no devolvió un id';
        return;
      }
      // Refetched rather than pushed locally, so item_count and anything
      // else the server decided stay authoritative.
      myDirs = [];
      await ensureMyDirsLoaded();
      dirNewTitle = '';
      await addToDir(id, item.identifier);
    } catch (err: any) {
      dirPopoverNotice = `✗ ${err?.message ?? String(err)}`;
    } finally {
      dirCreating = false;
    }
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
      // Close after a beat, so the ✓ is seen. Guarded on the film still being
      // the one that was filed: without it, filing A and quickly opening B
      // would slam B's dialog shut.
      setTimeout(() => {
        if (dirPickerItem?.identifier === identifier) closeDirPopover();
      }, 700);
    } catch (err: any) {
      dirPopoverNotice = `✗ ${err?.message ?? err}`;
    } finally { dirPopoverBusy = false; }
  }
  function closeDirPopover() {
    dirPickerItem = null;
    dirPopoverNotice = '';
    dirNewTitle = '';
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
      dbg('[cinema] loadFederatedSubs:', federatedSubs.length, 'rows', refresh ? '(refreshed)' : '(cached)');
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

      /**
       * Generate captions for this film.
       *
       * The adapter used to stop at listTracks/fetchVtt/remove, because
       * generation was driven by a separate wizard of this page's own rather
       * than through the controller. With that wizard gone, the player's
       * "Generate subtitles" button called a method nobody had implemented —
       * so the one remaining path did nothing at all.
       *
       * It delegates to the same orchestrator the wizard used, so there is
       * one transcription pipeline and not a second copy of it.
       */
      async generate(opts) {
        if (!playItem || !playFiles[playActiveIdx]) {
          throw new Error('no hay un archivo de video seleccionado');
        }
        if (opts?.lang) subSourceLang = opts.lang;
        // Transcribe only. Translation is its own call below, so asking for
        // captions never silently also translates them.
        translateActive = false;
        generateRequested = true;
        await runAutoTranslatePipeline();
      },

      /** Translate the current captions into `to`, via the same pipeline. */
      async translate(opts) {
        if (!playItem || !playFiles[playActiveIdx]) {
          throw new Error('no hay un archivo de video seleccionado');
        }
        subTargetLang = opts.to;
        if (opts.from) subSourceLang = opts.from;
        translateActive = true;
        generateRequested = true;
        await runAutoTranslatePipeline();
      },

      /** Stop whatever is running. */
      async cancel() {
        if (inflightAbort) { try { inflightAbort.abort(); } catch { /* already gone */ } }
        // 'cancelled', not 'done' — a cancel produced nothing, so the
        // controller must not go looking for a finished track to show.
        stopProgress(undefined, 'cancelled');
      },

      /**
       * Push-based progress, which the controller prefers over polling. Cinema
       * already runs an SSE channel against the kernel for exactly this data;
       * this hands it to the player instead of keeping it to itself.
       */
      subscribeProgress(onStatus) {
        jobListeners.add(onStatus);
        // Seed only when something IS running. Emitting an idle snapshot here
        // would clear `ctl.job` the instant the controller starts watching,
        // blanking the UI until the first SSE event arrives.
        const seed = currentJobStatus();
        if (seed.status === 'running') onStatus(seed);
        return () => { jobListeners.delete(onStatus); };
      },

      /** What the kernel can translate into — the menu's language list. */
      async languages() {
        if (!subInfo) await loadSubInfo();
        return (subInfo?.languages ?? []).map((l) => ({ code: l.iso, name: l.name }));
      },
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
    dbg('[cinema] applySubs: confirmed', { subSource, translateActive, subTargetLang, subEngine, transcribeEngine, transcribeModel });
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
    dbg('[cinema] applySubs: triggering maybeLoadTranscript');
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
    dbg('[cinema] pauseAndRewindForGeneration:', { wasPlaying, neverStarted, resume: resumeAfterSubs });
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
      dbg('[cinema] runAutoTranslatePipeline: using shipped sub instead of whisper:', shippedSrc.file.name);
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
    stopProgress(undefined, 'phase-swap');
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
    dbg('[cinema] ensureCurrentSubInCacheList: synthetic entry added', syntheticKey);
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
        dbg('[cinema] loadSubInfo: default engine →', subEngine,
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

  /**
   * Tear the subtitle pipeline down to a clean slate: abort whatever is in
   * flight, kill the timers, close the SSE channel and clear the busy flags.
   *
   * This has to run whenever the player leaves a video, not only when the
   * user cancels. Nothing used to: closing the modal or opening another film
   * left `translateBusy` stuck at true and `subsJobId` pointing at the
   * previous run's channel. The consequences compounded —
   *
   *   • the progress card rendered on the NEXT film reading "TRANSLATING 0%",
   *     for a translation that was not running;
   *   • `startProgress()` is idempotent on `translateBusy`, so it returned
   *     early and never armed a real run;
   *   • `loadTranscriptManual()` is gated on `!translateBusy`, so the lazy
   *     modal never armed either;
   *   • and the request carried the dead jobId, publishing progress to a
   *     channel with no subscriber left.
   *
   * Net effect: translate once, and every film after it showed a permanent
   * fake "loading" and could never be translated again for the life of the
   * tab. One teardown, called from every exit, is the whole fix.
   */
  function resetSubsPipeline(): void {
    // Abort BOTH the legacy generateSubs() path AND the unified-flow
    // loadTranscriptManual() fetch — whichever is running has to stop.
    if (transcribeAbort) {
      try { transcribeAbort.abort(); } catch { /* already gone */ }
      transcribeAbort = null;
    }
    if (inflightAbort) {
      try { inflightAbort.abort(); } catch { /* already gone */ }
      inflightAbort = null;
      inflightTrackUrl = '';
    }
    transcribeBusy = false;
    translateBusy = false;
    if (transcribeTimer) { clearInterval(transcribeTimer); transcribeTimer = null; }
    if (translateTimer) { clearInterval(translateTimer); translateTimer = null; }
    if (modalPhaseSwapTimer) { clearTimeout(modalPhaseSwapTimer); modalPhaseSwapTimer = null; }
    stopSubsProgressStream();          // closes the EventSource AND clears subsJobId
    failedTrackUrls = new Set();       // a new video gets a clean slate
    translateCuesDone = 0;
    translateCuesTotal = 0;
    translateEtaMs = 0;
    translateElapsedMs = 0;
    transcribeElapsedMs = 0;
    translateError = '';
  }

  function cancelGenerateSubs(): void {
    dbg('[cinema] cancelGenerateSubs: user cancelled');
    resetSubsPipeline();
    transcribeError = 'Cancelled by user.';
    subsApplied = false;          // user cancelled — let them re-configure
  }

  async function generateSubs() {
    if (transcribeBusy || !playItem || !playFiles[playActiveIdx]) return;
    dbg('[cinema] generateSubs: starting whisper', transcribeEngine, transcribeModel);
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
      dbg('[cinema] generateSubs: success', transcribeCueCount, 'cues in', Date.now() - transcribeStartedAt, 'ms');
      transcribeAvailable = true;
      subSource = 'auto';
      transcribeJustDone = true;
      setTimeout(() => { transcribeJustDone = false; }, 4500);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        dbg('[cinema] generateSubs: aborted (cancel or timeout)');
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
      dbg('[cinema] generateSubs: finally → transcribeBusy=false');
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
      dbg('[cinema] auto-enabling cached transcribed subs');
      subSource = 'auto';
    } else if (hasSrt) {
      dbg('[cinema] auto-enabling shipped SRT subs');
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
  /** Track URLs that failed permanently — never re-request them for this video. */
  let failedTrackUrls = new Set<string>();
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
          publishJobStatus();
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

  // ── Job status → the shared controller ─────────────────────────────
  //
  // The SSE above is the only live source of truth about a running subtitle
  // job. It used to write into cinema's own locals and nowhere else, so the
  // shared player's two surfaces — the chip in the bar and the progress block
  // in the caption menu — read a `ctl.job` nobody ever fed and sat at 0% for
  // the entire run, while cinema's own modal showed real cue counts beside
  // them. Three reports of one job, two of them wrong.
  //
  // `subscribeProgress` is the adapter hook the controller already prefers
  // over polling. Feeding it here makes the player the single owner of what
  // the user sees, and let cinema's duplicate modal go.
  let jobListeners = new Set<(s: SubsJobStatus) => void>();

  /** Build the current status from whatever the SSE has told us so far. */
  function currentJobStatus(): SubsJobStatus {
    const translating = translateBusy && translateMode === 'translate';
    const progress = translating
      ? (translateCuesTotal > 0 ? translateCuesDone / translateCuesTotal : 0)
      : transcribeFrac;
    return {
      status: (translateBusy || transcribeBusy) ? 'running' : 'idle',
      progress: Math.max(0, Math.min(1, progress)),
      phase: translating ? 'translate' : (transcribeSubPhase || 'transcribe'),
      hint: translating ? '' : transcribeHint,
      processedSec: transcribeProcessedSec,
      totalSec: transcribeTotalSec,
      error: '',
      cuesDone: translating ? translateCuesDone : undefined,
      cuesTotal: translating && translateCuesTotal > 0 ? translateCuesTotal : undefined,
      etaMs: translating && translateEtaMs > 0 ? translateEtaMs : undefined,
      engine: translating ? subEngine : transcribeEngine,
      route: translating ? `${subSourceLang} → ${subTargetLang}` : subSourceLang,
    };
  }

  function publishJobStatus(): void {
    const s = currentJobStatus();
    for (const fn of jobListeners) {
      try { fn(s); } catch { /* a listener must not break the stream */ }
    }
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
    publishJobStatus();   // the player's chip + menu light up immediately
  }
  /**
   * `outcome` says what actually happened, because this function is called
   * for three different things and the shared controller must not be told
   * the same story about all of them:
   *   'done'       — the run finished (or failed, if `err` is set)
   *   'cancelled'  — the user stopped it; nothing was produced
   *   'phase-swap' — transcribe ended, translate is about to start. The job
   *                  is still running; the controller must not hear a word.
   */
  function stopProgress(err?: string, outcome: 'done' | 'cancelled' | 'phase-swap' = 'done'): void {
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
    // A phase swap is NOT the end of the job, and saying it is broke the
    // translate button outright: the controller reacts to 'ready' by calling
    // onJobDone(), which unsubscribes us, refreshes the track list and shows
    // whatever it finds — and showing a track goes through the adapter's
    // load(), which aborts `inflightAbort`. That controller is the pipeline's
    // own AbortController, so phase 2 died on an AbortError the pipeline
    // swallows silently. Pressing Translate did nothing at all, with no error
    // anywhere. Only a real ending talks to the controller.
    if (outcome === 'phase-swap') return;
    const base = currentJobStatus();
    const terminal: SubsJobStatus =
      err ? { ...base, status: 'error', error: err }
      : outcome === 'cancelled' ? { ...base, status: 'idle' }
      : { ...base, status: 'ready', progress: 1 };
    for (const fn of jobListeners) {
      try { fn(terminal); } catch { /* a listener must not break teardown */ }
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
    dbg('[cinema] maybeLoadTranscript', { hasVideo: !!videoEl, url, subTrack, transcribeAvailable, hasPlayItem: !!playItem, filesLen: playFiles.length, lastLoadedTrackUrl });
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
    if (url === lastLoadedTrackUrl) { dbg('[cinema] maybeLoadTranscript: already loaded, skip'); return; }
    if (failedTrackUrls.has(url)) { dbg('[cinema] maybeLoadTranscript: known-bad url, skip'); return; }
    if (url === inflightTrackUrl) { dbg('[cinema] maybeLoadTranscript: in-flight, skip'); return; }
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
    dbg('[cinema] fetching VTT:', url);
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
    // `passthrough=1` is the same endpoint doing no translation at all — it
    // just converts a shipped .srt to WebVTT, which the browser needs because
    // <track> cannot read SRT. Counting it as a translation is why opening
    // any film that ships subtitles raised a full "TRANSLATING TO ESPAÑOL ·
    // LLM · EN → ES" modal that nobody asked for: the request never touched
    // an LLM, only the URL prefix matched.
    const isPassthrough = /[?&]passthrough=1(?:&|$)/.test(url);
    const isTranslate = url.startsWith('/api/cinema/media/translate-srt') && !isPassthrough;
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
    if ((isTranslate || isTranscribe) && !translateBusy && !transcribeBusy) {
      // Cache hits return in <100ms — only show progress if the response
      // genuinely delays beyond 1.5s. Re-check at fire time too.
      //
      // Translate used to open its modal eagerly, so a cached translation
      // flashed a full-screen "translating…" card on its way to being
      // instant. A real run takes minutes; 1.5s of nothing costs it nothing.
      const mode: 'translate' | 'transcribe' = isTranslate ? 'translate' : 'transcribe';
      lazyTimer = setTimeout(() => {
        if (!translateBusy && !transcribeBusy) startProgress(mode);
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
        const e = new Error(msg) as Error & { status?: number };
        e.status = r.status;
        throw e;
      }
      raw = await r.text();
    } catch (err) {
      // If we got aborted because a newer fetch superseded us, exit
      // silently — the new fetch's lifecycle owns the progress state.
      if (err instanceof Error && err.name === 'AbortError') {
        dbg('[cinema] VTT fetch aborted (superseded):', url.slice(-80));
        if (lazyTimer) clearTimeout(lazyTimer);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number })?.status;
      console.warn('[cinema] VTT fetch failed:', msg, status ? `(http ${status})` : '');
      // Some failures will never succeed on a retry: the shipped .srt has no
      // parseable cues (422), the URL is wrong (400/404), the extension is
      // gone (410). `lastLoadedTrackUrl` is only set on SUCCESS, so without
      // this the reactive re-fires the same doomed request forever — one
      // archive.org item with an empty .asr.srt produced a 422 on every
      // single update cycle. Transient codes (5xx, 429, network) stay
      // retryable on purpose.
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        failedTrackUrls.add(url);
      }
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
    // `manualTrack` is null since display moved to the shared controller —
    // every other reader here is guarded, this debug line was not, so it threw
    // `Cannot read properties of null (reading 'mode')` as the LAST statement
    // of the install. An unhandled rejection from a console.log, which also
    // propagated up through the controller's show() → onJobDone() path.
    console.log(`[cinema] manual track ready, cues=${parseVttShared(raw).length}`);
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
      if (playerIsPlaying) controlsVisible = false;
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
    // Startup states, for the preloader below.
    videoEl.addEventListener('loadstart', onStartupLoadStart);
    videoEl.addEventListener('progress', onStartupProgress);
    videoEl.addEventListener('waiting', onStartupWaiting);
    videoEl.addEventListener('stalled', onStartupWaiting);
    videoEl.addEventListener('canplay', onStartupReady);
    videoEl.addEventListener('playing', onStartupReady);
    subsCtl?.setVideo(videoEl);
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
  $: startupIndeterminate = playNeedsTranscode || startupBufferedFrac <= 0;

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
  let codecFallbackExpected = false;     // probe knew up front → informational, not an error
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
  function switchToTranscode(reason: string, opts?: { expected?: boolean }): void {
    if (codecFallbackUsed) return;
    if (!playItem || !playFiles[playActiveIdx]) return;
    codecFallbackUsed = true;
    const expected = opts?.expected === true;
    codecFallbackHint = expected
      ? `${reason} — transcoding for the browser`
      : `Codec not supported (${reason}) — switching to live transcode…`;
    codecFallbackExpected = expected;
    if (expected) dbg('[cinema] transcoding up front:', reason);
    else console.warn('[cinema] codec fallback:', reason);
    const built = buildPlayUrl(playItem, playFiles[playActiveIdx], true);
    playSrc = built.src;
    playNeedsTranscode = true;
    // Auto-clear once the transcode load is under way. The expected case is
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
    // Cleared immediately so the previous film's row never shows under the
    // new one, then refilled in the background — the strip is a nicety and
    // must never hold up playback.
    similarItems = [];
    loadSimilar(item.identifier);
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
    codecFallbackExpected = false;
    lastProbeVerdict = null;
    startupPhase = 'idle';
    startupBufferedFrac = 0;
    startupStop();
    resetSubsPipeline();              // a run from the previous video must not leak into this one
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
      dbg('[cinema] openPlayer: probing for cached transcript');
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
        dbg('[cinema] openPlayer: auto-recovering', auto.kind, auto.tgt_lang || auto.src_lang, auto.key);
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
        dbg('[cinema] openPlayer: /transcribe cache hit → auto subs');
        generateOpen = false;
        subSource = 'auto';
        subsApplied = true;
        activeSubKey = 'off';     // no matching sidecar — leave Off until reactive applies
      } else if (localHasSrt) {
        dbg('[cinema] openPlayer: shipped .srt only → enabling orig');
        generateOpen = false;
        subSource = 'orig';
        subsApplied = true;
        activeSubKey = 'shipped';
      } else {
        // No subs anywhere — default wizard to generate so the CTA is
        // obvious. User still has to click START.
        dbg('[cinema] openPlayer: no subs found → wizard primed for generate');
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
    codecFallbackExpected = false;
    lastProbeVerdict = null;
    startupPhase = 'idle';
    startupBufferedFrac = 0;
    startupStop();
    resetSubsPipeline();              // a run from the previous video must not leak into this one
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
    activeSubKey = 'off';
    cachedSubs = [];
    filesOpen = false;
    startupPhase = 'idle';
    startupStop();                    // don't leave a 100ms interval running
    resetSubsPipeline();              // closing mid-translation must not poison the next film
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
  function fmtBytes(n: number): string {
    if (n > 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + ' GB';
    if (n > 1_000_000) return (n / 1_000_000).toFixed(1) + ' MB';
    if (n > 1_000) return (n / 1_000).toFixed(1) + ' KB';
    return `${n} B`;
  }

  let observer: IntersectionObserver | null = null;
  onMount(async () => {
    // Whether the filters panel was left open last visit. Read before the
    // first paint so the panel does not slide open a frame after the header.
    try { filtersOpen = localStorage.getItem(FILTERS_OPEN_KEY) === '1'; } catch { /* private mode */ }
    // Hot-render from localStorage (instant) then reconcile with server.
    watchlist = loadLocalWatchlist();
    syncWatchlistFromServer();
    loadTopTags();
    loadCanonRails();
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

  /**
   * The same artwork, but same-origin, for the `<video poster>`.
   *
   * The player carries `crossorigin="anonymous"` so its cross-origin captions
   * work. That attribute applies to the POSTER too, which turns a plain image
   * load into a CORS request — and archive.org sends no
   * `Access-Control-Allow-Origin`. So every film logged a CORS failure and
   * fell back to the black rectangle the poster exists to prevent. Grid cards
   * are plain `<img>` with no crossorigin, so they load directly and stay off
   * the proxy.
   */
  function posterUrl(identifier: string): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const upstream = thumbUrl(identifier);
    return `${origin}/api/cinema/media/webseed-proxy?url=${encodeURIComponent(upstream)}${authQuery()}`;
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
  interface ActiveChip {
    id: string;
    label: string;
    /** Drives the colour: which taxonomy this chip came from. */
    tone: 'query' | 'tag' | 'rail' | 'filter';
    /** What removeActive() should undo. */
    act: string;
    value?: string;
  }

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

<div class="page" bind:this={scrollEl} on:scroll={onPageScroll}>
  <!-- ══ HEADER CHROME ═════════════════════════════════════════════
       Four bands, in the order the questions actually get asked:

         ①  what am I looking at        — identity + global actions
         ②  what am I looking for       — the search box, and the filters
         ③  what is narrowing it        — every active filter, in one line
         ④  what else could I look at   — curated rails, then tags

       What this replaces: four control systems (nav chips, a wrapping
       filter row, canon rails, thirty tag chips) rendered at the same
       visual weight, in four different chip languages, taking ~400px —
       the whole fold — before a single poster appeared. Nothing has been
       removed; it has been ordered, and the parts that are consulted
       rather than scanned now live behind one click.

       Every band is laid out on --gutter. The old tag row was not: it
       carried its own margin AND its own padding and started 12px further
       in than every band above it, which read as a rendering fault. -->
  <header class="chrome" class:condensed>
    <!-- ── ① identity + global actions ──────────────────────────── -->
    <div class="band band-id">
      <h1 class="wordmark">cinema<span class="caret" aria-hidden="true">▌</span></h1>
      <p class="subtitle">
        {#if viewWatchlist}
          {$t('header.watchlist', { n: watchlist.length })}
        {:else if busy && items.length === 0}
          {$t('header.loading')}
        {:else if query.trim()}
          {$t('header.results', { n: items.length, q: query.trim() })}
        {:else}
          {$t('header.catalogue', { n: items.length })}
        {/if}
      </p>
      <nav class="quick" aria-label={$t('nav.aria')}>
        <button
          type="button"
          class="qbtn"
          class:on={viewWatchlist}
          aria-pressed={viewWatchlist}
          title={$t('nav.watchlist.hint')}
          on:click={() => (viewWatchlist = !viewWatchlist)}
        >
          <Icon name="star" size={13} />
          <span>{$t('nav.watchlist')}</span>
          {#if watchlist.length}<span class="qbadge">{watchlist.length}</span>{/if}
        </button>
        <button
          type="button"
          class="qbtn"
          class:on={embedPanelOpen}
          aria-pressed={embedPanelOpen}
          title={$t('nav.embeddings.hint')}
          on:click={() => { embedPanelOpen = !embedPanelOpen; refreshEmbedStatus(); }}
        >
          <Icon name="cpu" size={13} />
          <span>{$t('nav.embeddings')}</span>
          {#if embedSnap?.status === 'running'}
            <span class="qpulse" role="img" aria-label={$t('nav.embeddings.running')}></span>
          {/if}
        </button>
        <a class="qbtn" href="/cinema/directories" title={$t('nav.directories.hint')}>
          <Icon name="folder" size={13} />
          <span>{$t('nav.directories')}</span>
        </a>
      </nav>
    </div>

    {#if !viewWatchlist}
      <!-- ── ② command bar ──────────────────────────────────────
           The search box is the only element on this page that gets to be
           large. It was previously one control among eight on a wrapping
           row, which put a year spinner and a checkbox at the same weight
           as the thing the page exists to do. The submit button is gone:
           Enter already searched, and the button was what pushed itself
           onto a second row once the toggles stretched the first. -->
      <div class="band band-cmd">
        <div class="searchbox">
          <span class="searchbox-icon"><Icon name="search" size={16} /></span>
          <input
            type="text"
            bind:value={query}
            placeholder={$t('search.placeholder')}
            aria-label={$t('search.aria')}
            aria-describedby="cinema-search-hint"
            on:keydown={(e) => e.key === 'Enter' && runSearch()}
          />
          {#if query}
            <button
              type="button"
              class="searchbox-clear"
              title={$t('search.clear')}
              aria-label={$t('search.clear')}
              on:click={() => { query = ''; runSearch(); }}
            >
              <Icon name="x" size={13} />
            </button>
          {/if}
          <kbd class="searchbox-key" aria-hidden="true">↵</kbd>
        </div>
        <span id="cinema-search-hint" class="sr-only">{$t('search.enter.hint')}</span>
        <button
          type="button"
          class="filters-btn"
          class:on={filtersOpen}
          aria-expanded={filtersOpen}
          aria-controls="cinema-filters"
          title={filtersOpen ? $t('filters.close') : $t('filters.toggle.hint')}
          on:click={toggleFilters}
        >
          <Icon name="sliders" size={15} />
          <span>{$t('filters.toggle')}</span>
          {#if panelFilterCount > 0}
            <span class="count-badge" aria-label={$t('filters.toggle.count', { n: panelFilterCount })}>
              {panelFilterCount}
            </span>
          {/if}
          <span class="caret-icon" class:open={filtersOpen}><Icon name="chevronDown" size={13} /></span>
        </button>
      </div>

      <!-- ── filters panel ──────────────────────────────────────
           Inline, not floating: it pushes the grid down instead of
           covering it, so you can watch the result set change while you
           change it. Every control has a visible label — the row this
           replaces used placeholder text ("year ≥", "language", "+ views")
           as labels, which vanish the moment a value is entered. -->
      {#if filtersOpen}
        <div class="fpanel" id="cinema-filters" transition:slide={{ duration: 180, easing: cubicOut }}>
          <div class="fgrid">
            <div class="field" role="group" aria-labelledby="f-year-label">
              <span class="field-label" id="f-year-label">{$t('filters.year')}</span>
              <div class="field-pair">
                <input
                  type="number" bind:value={yearMin} min="1888" max="2099"
                  placeholder={$t('filters.year.from.ph')}
                  aria-label={$t('filters.year.from')}
                  on:change={runSearch}
                />
                <span class="field-dash" aria-hidden="true">–</span>
                <input
                  type="number" bind:value={yearMax} min="1888" max="2099"
                  placeholder={$t('filters.year.to.ph')}
                  aria-label={$t('filters.year.to')}
                  on:change={runSearch}
                />
              </div>
            </div>

            <label class="field">
              <span class="field-label">{$t('filters.language')}</span>
              <select bind:value={langFilter} on:change={runSearch}>
                <option value="">{$t('filters.language.any')}</option>
                {#each CONTENT_LANGUAGES as code (code)}
                  <option value={code}>{languageName(code, $uiLocale)}</option>
                {/each}
              </select>
            </label>

            <label class="field">
              <span class="field-label">{$t('filters.kind')}</span>
              <select bind:value={kindFilter} on:change={runSearch}>
                <option value="">{$t('filters.kind.any')}</option>
                <option value="film">{$t('filters.kind.film')}</option>
                <option value="series">{$t('filters.kind.series')}</option>
              </select>
            </label>

            <label class="field">
              <span class="field-label">{$t('filters.sort')}</span>
              <select bind:value={sortMode} on:change={runSearch}>
                <option value="best">{$t('filters.sort.best')}</option>
                <option value="downloads">{$t('filters.sort.downloads')}</option>
                <option value="rating">{$t('filters.sort.rating')}</option>
                <option value="year_desc">{$t('filters.sort.year_desc')}</option>
                <option value="year_asc">{$t('filters.sort.year_asc')}</option>
                <option value="added_desc">{$t('filters.sort.added_desc')}</option>
              </select>
              <span class="field-help">{$t('filters.sort.hint')}</span>
            </label>

            <label class="field">
              <span class="field-label">{$t('filters.duration')}</span>
              <select bind:value={minMinutes} on:change={runSearch}>
                <option value={0}>{$t('filters.duration.any')}</option>
                <option value={20}>{$t('filters.duration.20')}</option>
                <option value={40}>{$t('filters.duration.40')}</option>
                <option value={60}>{$t('filters.duration.60')}</option>
              </select>
              <span class="field-help">{$t('filters.duration.hint')}</span>
            </label>

            <div class="field field-wide" role="group" aria-labelledby="f-content-label">
              <span class="field-label" id="f-content-label">{$t('filters.content')}</span>
              <div class="toggles">
                <label class="toggle" title={$t('toggle.collapse.hint')}>
                  <input type="checkbox" bind:checked={collapseWorks} on:change={runSearch} />
                  <span class="toggle-box"><Icon name="check" size={11} /></span>
                  <Icon name="layers" size={14} />
                  <span>{$t('toggle.collapse')}</span>
                </label>
                <label class="toggle" title={$t('toggle.playable.hint')}>
                  <input type="checkbox" bind:checked={playableOnly} on:change={runSearch} />
                  <span class="toggle-box"><Icon name="check" size={11} /></span>
                  <Icon name="play" size={14} />
                  <span>{$t('toggle.playable')}</span>
                </label>
                <label class="toggle" title={$t('toggle.subs.hint')}>
                  <input type="checkbox" bind:checked={subsOnly} on:change={runSearch} />
                  <span class="toggle-box"><Icon name="check" size={11} /></span>
                  <Icon name="captions" size={14} />
                  <span>{$t('toggle.subs')}</span>
                </label>
                <label class="toggle" title={$t('toggle.identified.hint')}>
                  <input type="checkbox" bind:checked={identifiedOnly} on:change={runSearch} />
                  <span class="toggle-box"><Icon name="check" size={11} /></span>
                  <Icon name="verified" size={14} />
                  <span>{$t('toggle.identified')}</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      {/if}

      <!-- ── ③ what is currently narrowing the grid ─────────────
           The band this page never had. Seven controls, a rail and a set
           of tags could all be filtering at once with nothing on screen
           saying which — reading the state meant reading every control.
           Each chip removes exactly its own filter. -->
      {#if activeChips.length > 0}
        <div class="band band-active" role="group" aria-label={$t('active.aria')}>
          <span class="eyebrow">{$t('active.label')}</span>
          <div class="active-list">
            {#each activeChips as chip (chip.id)}
              <button
                type="button"
                class="chip chip-removable"
                data-tone={chip.tone}
                title={$t('active.remove', { x: chip.label })}
                aria-label={$t('active.remove', { x: chip.label })}
                on:click={() => removeActive(chip)}
              >
                <span class="chip-text">{chip.label}</span>
                <Icon name="x" size={11} />
              </button>
            {/each}
            {#if activeTags.length >= 2}
              <button
                type="button"
                class="chip chip-mode"
                title={$t('active.match.hint')}
                on:click={toggleTagsMatch}
              >
                {tagsMatch === 'all' ? $t('active.match.all') : $t('active.match.any')}
              </button>
            {/if}
          </div>
          <button type="button" class="linkbtn" on:click={clearAllFilters}>
            <Icon name="eraser" size={13} />
            <span>{$t('active.clear')}</span>
          </button>
        </div>
      {/if}

      {#if !semanticMode}
        <!-- ── ④ discover ──────────────────────────────────────
             Above the tags because it answers the stronger question: not
             "what is this about" but "who decided this mattered". The
             eyebrow makes it read as a shelf; without it the "for you"
             chip sat alone against the gutter looking like a stray
             control on catalogues holding nothing from a curated list. -->
        <div class="band band-rail band-collapsible" role="group" aria-label={$t('discover.aria')}>
          <span class="eyebrow">{$t('discover.label')}</span>
          <div class="band-scroll">
            <button
              type="button"
              class="chip chip-computed"
              class:on={forYouMode}
              aria-pressed={forYouMode}
              title={$t('discover.forYou.hint')}
              on:click={toggleForYou}
            >
              <Icon name="sparkles" size={13} />
              <span class="chip-text">{$t('discover.forYou')}</span>
            </button>
            {#if canonRails.length > 0}
              <span class="band-sep" aria-hidden="true"></span>
            {/if}
            {#each canonRails as rail (rail.key)}
              <button
                type="button"
                class="chip chip-editorial"
                class:on={activeRail === rail.key}
                aria-pressed={activeRail === rail.key}
                title={$t('discover.rail.hint', { blurb: rail.blurb, held: rail.held, members: rail.members })}
                on:click={() => toggleRail(rail.key)}
              >
                <span class="chip-text">{rail.label}</span>
                <span class="chip-count">{rail.held}</span>
              </button>
            {/each}
          </div>
        </div>

        <!-- Why the rail came back empty. The three causes need different
             things from the user, so "no results" would leave them with
             nothing to do about it. -->
        {#if forYouMode && forYouReason !== 'ok' && forYouReason !== ''}
          <p class="band band-note">
            {#if forYouReason === 'no_profile'}
              {$t('foryou.noProfile', { n: forYouProfileSize })}
            {:else if forYouReason === 'no_vectors'}
              {$t('foryou.noVectors')}
            {:else}
              {$t('foryou.noDirection')}
            {/if}
          </p>
        {/if}

        <!-- ── ⑤ tags ─────────────────────────────────────────
             Tags are a browse axis, the sibling of DISCOVER above — not a
             filter like year or language. They used to be both: this row,
             AND a duplicate cloud nested inside the filters panel, two bands
             apart, drawn from the same `topTags`. Opening one printed Drama,
             Horror, Comedy and eleven more twice on the same screen, and the
             "all tags" link sent you to a section in a different container.

             One surface now. Collapsed it is ONE row that scrolls sideways
             rather than thirty chips wrapping to four; "all tags" expands it
             in place, right where you clicked, into the search box and the
             full cloud. Any tag at all can also be typed as #tag in the
             search box, which absorbs it as a filter. -->
        {#if topTags.length > 0}
          <div
            class="band band-tags"
            class:band-collapsible={!tagPanelOpen}
            class:band-tags-open={tagPanelOpen}
            role="group"
            aria-label={$t('tags.aria')}
          >
            <span class="eyebrow">{$t('tags.label')}</span>

            {#if !tagPanelOpen}
              <div class="band-scroll band-scroll-fade">
                {#each topTags.slice(0, 14) as tg (tg.tag_norm)}
                  <button
                    type="button"
                    class="chip chip-tag"
                    class:on={activeTags.includes(tg.tag_norm)}
                    aria-pressed={activeTags.includes(tg.tag_norm)}
                    title={$t('tags.hint', { n: tg.count.toLocaleString($uiLocale) })}
                    on:click={() => pickTag(tg.tag_norm)}
                  >
                    <span class="chip-text">{tg.tag_display}</span>
                    <span class="chip-count">{fmtDownloads(tg.count) || tg.count}</span>
                  </button>
                {/each}
              </div>
              <button
                type="button"
                class="linkbtn"
                aria-expanded="false"
                title={$t('tags.all.hint')}
                on:click={openTagPanel}
              >
                <span>{$t('tags.all')}</span>
                <Icon name="chevronRight" size={12} />
              </button>
            {:else}
              <div class="band-tags-body" transition:slide={{ duration: 150, easing: cubicOut }}>
                <div class="tag-search-wrap">
                  <span class="tag-search-icon"><Icon name="search" size={14} /></span>
                  <input
                    class="tag-search-input"
                    type="text"
                    bind:value={tagSearchQuery}
                    placeholder={$t('tags.search.placeholder')}
                    aria-label={$t('tags.search.placeholder')}
                    on:input={onTagSearchInput}
                    on:focus={() => { tagSearchOpen = true; if (tagSearchQuery) onTagSearchInput(); }}
                    on:blur={closeTagSearchSoon}
                  />
                  {#if tagSearchOpen && (tagSearchHits.length > 0 || tagSearchBusy || tagSearchQuery.trim())}
                    <div class="tag-search-popover">
                      {#if tagSearchBusy}
                        <div class="tag-search-empty">{$t('tags.search.busy')}</div>
                      {:else if tagSearchHits.length === 0}
                        <div class="tag-search-empty">{$t('tags.search.empty', { q: tagSearchQuery })}</div>
                      {:else}
                        {#each tagSearchHits as tg (tg.tag_norm)}
                          <button
                            type="button"
                            class="tag-search-row"
                            class:active={activeTags.includes(tg.tag_norm)}
                            on:mousedown|preventDefault={() => pickTagFromSearch(tg)}
                          >
                            <span class="tag-search-name">
                              {#if activeTags.includes(tg.tag_norm)}<Icon name="check" size={12} />{/if}
                              {tg.tag_display}
                            </span>
                            <span class="chip-count">{fmtDownloads(tg.count) || tg.count}</span>
                          </button>
                        {/each}
                      {/if}
                    </div>
                  {/if}
                </div>
                <div class="tag-cloud">
                  {#each topTags as tg (tg.tag_norm)}
                    <button
                      type="button"
                      class="chip chip-tag"
                      class:on={activeTags.includes(tg.tag_norm)}
                      aria-pressed={activeTags.includes(tg.tag_norm)}
                      title={$t('tags.hint', { n: tg.count.toLocaleString($uiLocale) })}
                      on:click={() => pickTag(tg.tag_norm)}
                    >
                      <span class="chip-text">{tg.tag_display}</span>
                      <span class="chip-count">{fmtDownloads(tg.count) || tg.count}</span>
                    </button>
                  {/each}
                </div>
              </div>
              <button
                type="button"
                class="linkbtn"
                aria-expanded="true"
                title={$t('tags.less.hint')}
                on:click={closeTagPanel}
              >
                <span>{$t('tags.less')}</span>
                <Icon name="chevronDown" size={12} />
              </button>
            {/if}
          </div>
        {/if}
      {/if}
    {/if}
  </header>

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
        animate:flip={{ duration: 320, easing: cubicOut }}
        on:click={() => openPlayer(it)}
        on:mouseenter={() => hoverItem = it.identifier}
        on:mouseleave={() => hoverItem === it.identifier && (hoverItem = null)}
      >
        <img class="poster" src={thumbUrl(it.identifier)} alt={it.title} loading="lazy" on:error={onPosterError} />

        <div class="overlay">
          <div class="ovl-title">{it.title || it.identifier}</div>
          <!-- Facts, on exactly one line that never wraps.
               This used to be a wrapping row of up to eight badges plus the
               creator plus the download count. Every card ended up a different
               height of metadata, so the grid had no rhythm and the badges
               read as noise rather than information. What survives is what you
               scan a poster wall for; the rest moved to the ℹ sheet, which is
               where you go when you actually want to know. -->
          <div class="ovl-meta">
            {#if it.date}<span class="fact year">{it.date.slice(0, 4)}</span>{/if}
            <!-- Prefer the probed duration: runtime_sec is 0 on a large part
                 of the catalogue, and where both exist the probe read it off
                 the file rather than off a metadata field someone typed. -->
            {#if it.media?.duration_sec}
              <span class="fact" title="duración real, leída de los archivos del ítem">{fmtRuntime(it.media.duration_sec)}</span>
            {:else if it.runtime_sec}
              <span class="fact" title="duración declarada">{fmtRuntime(it.runtime_sec)}</span>
            {/if}
            {#if it.media?.height}
              <span class="fact" title={`${it.media.width}×${it.media.height} · ${it.media.best_format}`}>{it.media.height}p</span>
            {/if}
            {#if it.media?.has_subtitles}<span class="fact" title="trae subtítulos">SUBS</span>{/if}
            {#if it.downloads}<span class="fact dl" title="descargas">⇩ {fmtDownloads(it.downloads)}</span>{/if}
          </div>
          <!-- Second fixed line: who made it. Always rendered, even empty, so
               every card in the grid is the same height. -->
          <div class="ovl-creator">{it.creator ?? ''}</div>
        </div>

        <!-- Quality marks, top-right and away from the title.
             These answer "is this worth your time", which is a different
             question from "what is it" — mixing them into the same row was
             what made both unreadable. At most three ever show. -->
        <div class="card-flags">
          {#if it.media && !it.media.has_video}
            <span class="flag bad" title="el ítem no contiene ningún archivo de video">SIN VIDEO</span>
          {/if}
          {#if it.canon?.length}
            {@const rail = canonRails.find((r) => r.key === it.canon?.[0])}
            <span class="flag rail" title={it.canon.map((k) => canonRails.find((r) => r.key === k)?.label ?? k).join(' · ')}>
              ★ {rail?.label ?? it.canon[0]}{#if it.canon.length > 1}&nbsp;+{it.canon.length - 1}{/if}
            </span>
          {/if}
          {#if it.canonical}
            <span class="flag canon"
                  title={`identificada: ${it.canonical.label}${it.canonical.year ? ` (${it.canonical.year})` : ''}${it.canonical.director ? ` · ${it.canonical.director}` : ''}${it.canonical.country ? ` · ${it.canonical.country}` : ''}`}
            >🎬{#if it.canonical.ext_votes > 0}&nbsp;{it.canonical.ext_rating.toFixed(1)}{/if}</span>
          {/if}
          {#if it.copies && it.copies > 1}
            <span class="flag copies" title={`${it.copies} subidas de esta película — descargas y votos sumados`}>⧉ {it.copies}</span>
          {/if}
        </div>

        <!-- One toolbar instead of three absolutely-placed buttons. They were
             pinned at left 48/86/124 — gaps of 40, 38, 38, and a 48px indent
             that was the hole left by a play button whose markup is long gone
             (its CSS still is; removed below). A flex row owns the spacing, so
             the group starts flush at the left and adding or dropping a
             control cannot desync the numbers again. -->
        <div class="card-actions">
          <span
            class="card-act star-btn"
            class:saved={isSaved(it.identifier)}
            role="button"
            tabindex="0"
            title={isSaved(it.identifier) ? 'remove from watchlist' : 'save to watchlist'}
            on:click|stopPropagation={() => toggleWatch(it)}
            on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && toggleWatch(it)}
          >{isSaved(it.identifier) ? '★' : '☆'}</span>
          <span
            class="card-act dir-btn"
            role="button"
            tabindex="0"
            title="guardar en un directorio"
            on:click={(ev) => openDirPicker(it, ev)}
            on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && openDirPicker(it, e)}
          >📁</span>
        <!-- Read the description properly. The hover overlay clips it and
             cannot be scrolled, so anything past a few lines was unreachable. -->
          <span
            class="card-act info-btn"
            role="button"
            tabindex="0"
            title="ver la ficha completa"
            on:click={(ev) => openInfo(it, ev)}
            on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && openInfo(it, e)}
          >ℹ</span>
        </div>

        {#if hoverItem === it.identifier && it.description}
          <div class="hover-desc">
            <!-- Full text, clamped in CSS. Slicing at 360 characters cut
                 mid-word at a count that knows nothing about the card's width
                 or font size, and then `overflow: hidden` cut it AGAIN at
                 whatever pixel the box ended — two truncations fighting, and
                 neither landing on a line boundary. -->
            <p class="hover-text">{it.description}</p>
            {#if it.subject?.length}
              <div class="tags">
                {#each it.subject.slice(0, 4) as s}<span class="tag">#{s}</span>{/each}
              </div>
            {/if}
            <!-- A real control, not a caption. It first shipped as a plain
                 <span>, and since the overlay is `pointer-events: none` the
                 click fell straight through to the card and opened the video
                 — a thing that looked tappable and did the wrong thing, which
                 is worse than no affordance at all. `role="button"` rather
                 than <button> because the card itself is a <button> and
                 nesting one inside another is invalid; the star/folder/info
                 controls above use the same pattern. -->
            <span
              class="hover-more"
              role="button"
              tabindex="0"
              title="ver la ficha completa"
              on:click|stopPropagation={(ev) => openInfo(it, ev)}
              on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && openInfo(it, e)}
            >ℹ ficha completa</span>
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
                  on:mouseleave={() => { if (playerIsPlaying) controlsVisible = false; }}
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
                  <!-- `poster` shows the item's own artwork until the first
                       frame decodes. The player has supported it all along;
                       cinema simply never passed one, which is why starting a
                       video was a black rectangle for several seconds. -->
                  <KernlPlayer
                    bind:video={videoEl}
                    src={playSrc}
                    poster={playItem ? posterUrl(playItem.identifier) : ''}
                    live={false}
                    autoplay={true}
                    crossorigin="anonymous"
                    ctl={subsCtl}
                    tick={subsTick}
                    ready={!startupBusy}
                  >
                    <!-- No gear. Subtitles are managed in the player's own
                         caption menu, which is the only place they live now. -->

                    <svelte:fragment slot="overlay">

                  <!-- ── Startup preloader ──────────────────────────────
                       The gap between "modal opened" and "first frame" is
                       seconds long on a cold archive.org fetch and longer
                       behind the transcoder. It used to be a black rectangle
                       with a dead play glyph, which reads as broken.

                       Reports the real thing: phase, elapsed, and the actual
                       buffered fraction when the browser knows one. Hidden
                       under the subtitle modals so two cards never stack. -->
                  {#if startupBusy && !translateBusy && !transcribeBusy}
                    <div class="vboot" role="status" aria-live="polite">
                      <div class="vboot-card">
                        <!-- Film leader: four sprocket bars chasing each other.
                             Pure decoration, and the only part that is. -->
                        <div class="vboot-reel" aria-hidden="true">
                          <span></span><span></span><span></span><span></span>
                        </div>

                        <div class="vboot-label">
                          {#if playNeedsTranscode}
                            {$t('boot.transcoding')}
                          {:else if startupPhase === 'connecting'}
                            {$t('boot.connecting')}
                          {:else}
                            {$t('boot.buffering')}
                          {/if}
                        </div>

                        <!-- Determinate whenever `video.buffered` gives us a
                             real fraction; a sweeping phosphor line otherwise,
                             so it never pretends to know a percentage. -->
                        <div
                          class="vboot-bar"
                          class:indeterminate={startupIndeterminate}
                          role="progressbar"
                          aria-valuemin="0"
                          aria-valuemax="100"
                          aria-valuenow={startupIndeterminate ? undefined : Math.round(startupBufferedFrac * 100)}
                        >
                          <div
                            class="vboot-fill"
                            style={startupIndeterminate ? '' : `width:${(startupBufferedFrac * 100).toFixed(1)}%`}
                          ></div>
                        </div>

                        <div class="vboot-meta">
                          <span class="vboot-elapsed">{(startupElapsedMs / 1000).toFixed(1)}s</span>
                          {#if !startupIndeterminate}
                            <span class="vboot-sep">·</span>
                            <span>{Math.round(startupBufferedFrac * 100)}% {$t('boot.buffered')}</span>
                          {/if}
                          {#if playNeedsTranscode}
                            <span class="vboot-sep">·</span>
                            <span class="vboot-note">{$t('boot.noSeek')}</span>
                          {/if}
                        </div>
                      </div>
                    </div>
                  {/if}

                  <!-- Suppressed while a subtitle modal owns the screen: the
                       banner is `position:absolute; left/right:12px` and was
                       drawing a full-width amber bar straight through the
                       centred card. -->
                  {#if codecFallbackHint && !translateBusy && !transcribeBusy}
                    <div
                      class="codec-fallback-banner"
                      class:cfb-expected={codecFallbackExpected}
                      role="status"
                    >
                      <span class="cfb-spinner"></span>
                      {codecFallbackHint}
                    </div>
                  {/if}

                  <!-- Settings popover (over the video, top-right). Three tabs:
                       subs, style, speed. Closes when the user clicks outside
                       (handled by the .video-stack mousedown). -->
                    </svelte:fragment>

                    <!-- ── COMMUNITY SUBTITLES ────────────────────────
                         The one thing the shared player cannot know about:
                         subtitles other people published over Nostr and
                         archive.org. This used to be a whole second panel
                         behind a gear icon, which meant choosing a track was
                         in one place and finding a track was in another.
                         Now it is the last section of the same menu. -->
                    <svelte:fragment slot="cc-extra">
                      {#if playItem}
                        <div class="cc-fed">
                          <div class="cc-fed-head">
                            <span>De la comunidad</span>
                            <button
                              class="cc-fed-refresh"
                              disabled={federatedRefreshing}
                              on:click={() => loadFederatedSubs(true)}
                              title="Buscar en Nostr y archive.org"
                              aria-label="Buscar en la red"
                            >{federatedRefreshing ? '…' : '↻'}</button>
                          </div>

                          {#if federatedError}
                            <p class="cc-fed-err">{federatedError}</p>
                          {/if}

                          {#if federatedShown.length === 0}
                            <p class="cc-fed-empty">
                              {federatedSubs.length === 0
                                ? 'Nadie compartió subtítulos de esta película todavía.'
                                : 'Ningún publicador confiable ofrece subtítulos.'}
                            </p>
                          {:else}
                            {#each federatedShown as row (row.rowId)}
                              {@const pub = publishersMap[row.signerPubkey]}
                              {@const trust = pub?.trust ?? 'unknown'}
                              <!-- One row, one line: language and who made it
                                   are what you choose by; provider and size
                                   are detail and live in the tooltip. -->
                              <div class="cc-fed-row" class:got={row.downloadedSubId}>
                                <span class="cc-fed-lang">{row.tgtLang || '??'}</span>
                                <span
                                  class="cc-fed-who"
                                  title={`${row.providerId} · ${row.engine || 'humano'} · ${fmtBytesShort(row.sizeBytes)}`}
                                >
                                  {row.engine || 'humano'}
                                  {#if row.signerPubkey}· {pub?.alias || shortPubkey(row.signerPubkey)}{/if}
                                </span>
                                {#if trust === 'trusted'}
                                  <span class="cc-fed-trust" title="Publicador confiable">★</span>
                                {/if}
                                {#if row.downloadedSubId}
                                  <span class="cc-fed-got" title="Ya lo tenés">✓</span>
                                {:else}
                                  <button
                                    class="cc-fed-get"
                                    disabled={downloadingRowIds.has(row.rowId) || !row.webseedUrl}
                                    on:click={() => downloadFederated(row)}
                                    title={row.webseedUrl || 'Sin webseed disponible'}
                                  >{downloadingRowIds.has(row.rowId) ? '…' : 'Usar'}</button>
                                {/if}
                              </div>
                            {/each}
                          {/if}

                          <label class="cc-fed-trustonly">
                            <input type="checkbox" bind:checked={federatedTrustOnly} />
                            Sólo publicadores confiables
                          </label>
                        </div>
                      {/if}
                    </svelte:fragment>
                  </KernlPlayer>

                  <!-- Progress for a running subtitle job is NOT drawn here.
                       It belongs to the player: the chip in its bar is the
                       glanceable summary and the block in its caption menu the
                       detail, both read from the one `ctl.job` this page now
                       feeds over `subscribeProgress`. A big centered modal used
                       to sit on top of those two, built from separate local
                       state — so one screen reported the same translation three
                       times, and the two the modal covered said 0% because
                       nothing was feeding them. What stays here is what the
                       player has no way to know: the finished/failed toasts. -->
                  {#if transcribeJustDone}
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
              <!-- Only once playback is under way. While the preloader is up it
                   already says both of these — and better: it shows the real
                   elapsed time, where this line promised "1-3s startup" over a
                   card reading 19.7s. Two notices, one of them wrong. What
                   survives here is the part the preloader stops saying when it
                   disappears: why the scrubber won't move. -->
              {#if playNeedsTranscode && !startupBusy}
                <div class="transcode-note dim mini">
                  ⚙ {$t('transcode.note', { fmt: active?.name.split('.').pop()?.toUpperCase() ?? '' })}
                </div>
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

        <!-- ── MORE LIKE THIS ────────────────────────────────────
             The route from a film you liked to the next one, which is the
             thing a catalogue of this size most lacks. Cosine over the
             stored vectors, so it works on the cartoons and industrial
             shorts that no identification-based signal can see.
             Rendered only when there is something to show: an empty row
             under every film would just be noise. -->
        {#if similarItems.length > 0}
          <div class="similar-row" role="region" aria-label="Similar titles">
            <div class="similar-head">▸ MÁS COMO ESTO</div>
            <div class="similar-strip">
              {#each similarItems as s (s.identifier)}
                <button class="similar-card" on:click={() => openPlayer(s)} title={s.title}>
                  <img src={thumbUrl(s.identifier)} alt={s.title} loading="lazy" on:error={onPosterError} />
                  <span class="similar-title">{s.title || s.identifier}</span>
                  {#if s.date}<span class="dim mini">{s.date.slice(0, 4)}</span>{/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ── FILM SHEET ───────────────────────────────────────────
       The description at a size meant for reading, scrollable, selectable,
       with the metadata the archive actually holds beside it. From here the
       two things you might want next — watch it, file it — are one click
       away, so opening the sheet is never a dead end. -->
  {#if infoItem}
    <div class="modal-back" on:click|self={closeInfo} role="presentation">
      <div class="info-dialog" role="dialog" aria-modal="true" aria-label="Ficha de la película">
        <header class="dir-dialog-head">
          <span>FICHA</span>
          <button class="ghost sm" on:click={closeInfo} aria-label="cerrar">×</button>
        </header>

        <div class="info-body">
          <img class="info-poster" src={thumbUrl(infoItem.identifier)} alt="" on:error={onPosterError} />

          <div class="info-main">
            <h2 class="info-title">{infoItem.title || infoItem.identifier}</h2>

            <div class="info-facts">
              {#if infoItem.canonical?.year || infoItem.date}
                <span>{infoItem.canonical?.year || infoItem.date?.slice(0, 4)}</span>
              {/if}
              {#if infoItem.canonical?.director}<span>{infoItem.canonical.director}</span>{/if}
              {#if infoItem.canonical?.country}<span>{infoItem.canonical.country}</span>{/if}
              {#if infoItem.media?.duration_sec}<span title="duración">{fmtRuntime(infoItem.media.duration_sec)}</span>
              {:else if infoItem.runtime_sec}<span title="duración">{fmtRuntime(infoItem.runtime_sec)}</span>{/if}
              {#if infoItem.media?.height}<span title="resolución vertical">{infoItem.media.height}p</span>{/if}
              {#if infoItem.downloads}<span title="descargas en archive.org">⇩ {fmtDownloads(infoItem.downloads)}</span>{/if}
              {#if infoItem.copies && infoItem.copies > 1}<span>⧉ {infoItem.copies} copias</span>{/if}
            </div>

            {#if infoItem.creator}
              <div class="dim mini info-creator">{infoItem.creator}</div>
            {/if}

            {#if infoItem.description}
              <!-- Synopsis toolbar: language, and the state of what you are
                   reading. Sits above the text so it is found before the wall
                   of English, not after it. -->
              <div class="desc-bar">
                <span class="desc-state" class:on={!!descLang}>
                  {descLang
                    ? `traducido · ${DESC_LANGS.find((l) => l.code === descLang)?.label ?? descLang}`
                    : 'texto original'}
                </span>
                <span class="spacer" />
                {#if descLang}
                  <button class="desc-btn" on:click={() => (descLang = '')}>ver original</button>
                {/if}
                <select
                  class="desc-lang"
                  bind:value={descTarget}
                  disabled={descBusy}
                  aria-label="idioma de la traducción"
                >
                  {#each DESC_LANGS as l}<option value={l.code}>{l.label}</option>{/each}
                </select>
                <button
                  class="desc-btn primary"
                  disabled={descBusy || descLang === descTarget}
                  on:click={translateDescription}
                  title="traducir la sinopsis con el modelo configurado"
                >
                  {#if descBusy}
                    <span class="desc-spin" aria-hidden="true"></span> traduciendo…
                  {:else}
                    <Icon name="globe" size={12} /> traducir
                  {/if}
                </button>
              </div>

              {#if descErr}
                <div class="desc-err" role="alert">
                  ⚠ no se pudo traducir: {descErr}
                  <button class="desc-err-x" on:click={() => (descErr = '')} aria-label="cerrar">×</button>
                </div>
              {/if}

              <p class="info-desc" class:clamped={descIsLong && !descShowFull}>{descShown}</p>

              {#if descIsLong}
                <button class="desc-btn desc-more" on:click={() => (descShowFull = !descShowFull)}>
                  {descShowFull ? '▲ ver menos' : '▼ leer completa'}
                </button>
              {/if}

              {#if descLang && descModel}
                <p class="desc-credit dim mini">traducido por {descModel}</p>
              {/if}
            {:else}
              <p class="info-desc dim">Este ítem no trae descripción en archive.org.</p>
            {/if}

            {#if infoItem.subject?.length}
              <div class="info-tags">
                {#each infoItem.subject.slice(0, 14) as t}<span class="tag">{t}</span>{/each}
              </div>
            {/if}
          </div>
        </div>

        <footer class="info-actions">
          <button class="primary" on:click={() => { const i = infoItem; closeInfo(); if (i) openPlayer(i); }}>
            ▶ ver
          </button>
          <button class="ghost" on:click={(ev) => { const i = infoItem; closeInfo(); if (i) openDirPicker(i, ev); }}>
            📁 guardar en…
          </button>
          <span class="spacer" />
          <a class="dim mini" href={`https://archive.org/details/${encodeURIComponent(infoItem.identifier)}`}
             target="_blank" rel="noopener noreferrer">ver en archive.org →</a>
        </footer>
      </div>
    </div>
  {/if}

  <!-- ── SAVE TO A DIRECTORY ───────────────────────────────────
       A dialog at page level rather than a popover inside the card. The old
       one was absolutely positioned over the poster, so it covered the single
       thing you needed to see: which film you were filing. Here the film is
       the first thing in it. -->
  {#if dirPickerItem}
    <div class="modal-back" on:click|self={closeDirPopover} role="presentation">
      <div class="dir-dialog" role="dialog" aria-modal="true" aria-label="Guardar en un directorio">
        <header class="dir-dialog-head">
          <span>GUARDAR EN…</span>
          <button class="ghost sm" on:click={closeDirPopover} aria-label="cerrar">×</button>
        </header>

        <div class="dir-dialog-subject">
          <img src={thumbUrl(dirPickerItem.identifier)} alt="" on:error={onPosterError} />
          <div>
            <div class="dir-dialog-title">{dirPickerItem.title || dirPickerItem.identifier}</div>
            {#if dirPickerItem.date}<div class="dim mini">{dirPickerItem.date.slice(0, 4)}</div>{/if}
          </div>
        </div>

        {#if myDirs.length > 0}
          <ul class="dir-dialog-list">
            {#each myDirs as d (d.id)}
              <li>
                <button
                  on:click={() => dirPickerItem && addToDir(d.id, dirPickerItem.identifier)}
                  disabled={dirPopoverBusy}
                >
                  <span class="dir-name">{d.title}</span>
                  <span class="dim mini">{d.item_count} títulos</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        <!-- Always available, not just when the list is empty: the moment you
             most want a new directory is when none of the existing ones fit. -->
        <form class="dir-dialog-new" on:submit|preventDefault={createDirAndAdd}>
          <label class="dim mini" for="dir-new-title">
            {myDirs.length === 0
              ? 'Todavía no tenés directorios. Creá el primero y esta película entra sola:'
              : 'O creá uno nuevo con esta película adentro:'}
          </label>
          <div class="dir-dialog-new-row">
            <input
              id="dir-new-title"
              bind:value={dirNewTitle}
              placeholder="ej. Terror clase B"
              maxlength="80"
              disabled={dirCreating || dirPopoverBusy}
            />
            <button class="primary" type="submit" disabled={!dirNewTitle.trim() || dirCreating || dirPopoverBusy}>
              {dirCreating ? '…' : 'crear y guardar'}
            </button>
          </div>
        </form>

        {#if dirPopoverNotice}
          <div class="dir-dialog-notice" class:ok={dirPopoverNotice.startsWith('✓')}>
            {dirPopoverNotice}
          </div>
        {/if}

        <a class="dim mini dir-dialog-manage" href="/cinema/directories">administrar directorios →</a>
      </div>
    </div>
  {/if}
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

  /* ══ HEADER CHROME ═══════════════════════════════════════════════
     One gutter, one chip language, one motion curve.

     What this replaces: four separate chip systems (a lowercase 11.5px
     green pill, a 12px gold square-cornered tab, a 12px white pill and a
     native checkbox) rendered at the same visual weight, plus a tag row
     that carried BOTH a 32px margin and a 12px padding and therefore
     started 12px further in than every band above it. That offset is the
     thing that read as "misaligned" — it was, by exactly 12px.

     Contrast note: --text-3 (#4A4F6A) is ~2.3:1 on --bg and fails AA for
     text at any size. The old header used it (via the --green-dim alias)
     for chip labels, section labels and the "more tags" link. It survives
     here only as a border and dash colour; anything readable uses
     --text-2 (~5.6:1) or an accent. */
  .chrome {
    --gutter: 32px;
    --chip-h: 27px;
    /* One easing for the whole header. Mixed curves are why a set of
       controls can feel like it came from three different products. */
    --ease: cubic-bezier(0.2, 0.8, 0.25, 1);
    /* Fixed column so the eyebrows of bands ③④⑤ put their chips on the
       same x. Sized for the longest label across en/es; a longer word in
       a future locale overflows into the 10px gap rather than pushing the
       chips out of alignment, which is the failure worth avoiding. */
    --eyebrow-w: 84px;

    position: sticky;
    top: 0;
    z-index: 5;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--amber) 5%, transparent), transparent 70%),
      color-mix(in srgb, var(--bg) 84%, transparent);
    backdrop-filter: blur(14px) saturate(1.15);
    border-bottom: 1px solid var(--line);
  }

  .band {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 var(--gutter);
    min-height: 40px;
  }

  /* Section label. Small caps rather than a chip, so it reads as the name
     of a shelf and not as another thing to click — the previous "descubrir"
     was styled like the dim chips beside it and got clicked. */
  .eyebrow {
    flex: 0 0 var(--eyebrow-w);
    font-family: var(--font-display);
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-2);
    white-space: nowrap;
    line-height: 1;
  }

  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* One focus treatment for every control in the header. The old one had
     none at all: keyboard users could not see where they were. */
  .chrome button:focus-visible,
  .chrome a:focus-visible,
  .chrome input:focus-visible,
  .chrome select:focus-visible {
    outline: 2px solid var(--amber);
    outline-offset: 2px;
  }

  /* ─── ① identity + global actions ───────────────────────────── */
  .band-id {
    align-items: baseline;
    gap: 14px;
    padding-top: 15px;
    padding-bottom: 11px;
    transition: padding 0.24s var(--ease);
  }
  .wordmark {
    margin: 0;
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0.035em;
    line-height: 1;
    color: var(--amber);
    text-shadow: 0 0 20px color-mix(in srgb, var(--amber) 32%, transparent);
    transition: font-size 0.24s var(--ease);
  }
  .caret {
    font-weight: 400;
    opacity: 0.6;
    animation: blink 1.1s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  .subtitle {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    font-size: 12px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .quick {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .qbtn {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 11px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.14s var(--ease), background 0.14s var(--ease), border-color 0.14s var(--ease);
  }
  /* Pointer target grown to 44px without growing the drawn control — the
     visual density this header needs and the touch minimum are not the
     same number. -2px horizontally keeps neighbours from overlapping
     inside the 2px gap. */
  .qbtn::before { content: ''; position: absolute; inset: -7px -1px; }
  .qbtn:hover {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 8%, transparent);
  }
  .qbtn.on {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 13%, transparent);
    border-color: color-mix(in srgb, var(--amber) 42%, transparent);
  }
  .qbadge {
    min-width: 17px;
    height: 17px;
    padding: 0 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: color-mix(in srgb, var(--amber) 20%, transparent);
    color: var(--amber);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .qpulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--cyan);
    animation: qpulse 1.7s var(--ease) infinite;
  }
  @keyframes qpulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 color-mix(in srgb, var(--cyan) 55%, transparent); }
    70% { opacity: 0.75; box-shadow: 0 0 0 5px transparent; }
  }

  /* ─── ② command bar ─────────────────────────────────────────── */
  .band-cmd {
    align-items: stretch;
    gap: 10px;
    padding-bottom: 13px;
    min-height: 0;
  }
  .searchbox {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 42px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: color-mix(in srgb, var(--surface-2) 80%, transparent);
    color: var(--text-2);
    transition: border-color 0.16s var(--ease), box-shadow 0.16s var(--ease),
                background 0.16s var(--ease), color 0.16s var(--ease);
  }
  .searchbox:focus-within {
    color: var(--amber);
    background: var(--surface-2);
    border-color: color-mix(in srgb, var(--amber) 65%, transparent);
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--amber) 13%, transparent),
      0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .searchbox-icon { display: inline-flex; flex: 0 0 auto; }
  .searchbox input {
    flex: 1 1 auto;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
    font: inherit;
    font-size: 14px;
    color: var(--text-1);
  }
  .searchbox input::placeholder { color: var(--text-2); opacity: 0.75; }
  /* The box already shows focus; a second ring inside it is noise. */
  .searchbox input:focus-visible { outline: none; }
  .searchbox-clear {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    padding: 3px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--text-2);
    cursor: pointer;
    transition: color 0.14s var(--ease), background 0.14s var(--ease);
  }
  .searchbox-clear::before { content: ''; position: absolute; inset: -9px; }
  .searchbox-clear:hover { color: var(--red); background: color-mix(in srgb, var(--red) 14%, transparent); }
  .searchbox-key {
    flex: 0 0 auto;
    padding: 2px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: color-mix(in srgb, var(--surface-3) 70%, transparent);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1.4;
  }

  .filters-btn {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 42px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: color-mix(in srgb, var(--surface-2) 80%, transparent);
    color: var(--text-2);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.15s var(--ease), background 0.15s var(--ease), border-color 0.15s var(--ease);
  }
  .filters-btn:hover { color: var(--text-1); border-color: var(--border-h, #2A2E48); }
  .filters-btn.on {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 11%, transparent);
    border-color: color-mix(in srgb, var(--amber) 45%, transparent);
  }
  .caret-icon {
    display: inline-flex;
    opacity: 0.7;
    transition: transform 0.2s var(--ease);
  }
  .caret-icon.open { transform: rotate(180deg); }

  .count-badge {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: var(--amber);
    color: var(--bg);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  /* ─── filters panel ─────────────────────────────────────────── */
  .fpanel {
    padding: 0 var(--gutter) 16px;
    border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 70%, transparent), transparent 90%);
  }
  .fgrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 15px 18px;
    padding: 16px 0 4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .field-wide { grid-column: 1 / -1; }
  /* Visible, permanent labels. The row this replaces used placeholder text
     as its labels ("year ≥", "language", "+ views"), which means the label
     disappears exactly when a value exists to explain. */
  .field-label {
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--text-2);
    line-height: 1;
  }
  .field select,
  .field-pair input {
    height: 34px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-1);
    font: inherit;
    font-size: 13px;
    outline: none;
    transition: border-color 0.14s var(--ease), box-shadow 0.14s var(--ease);
  }
  .field select { cursor: pointer; width: 100%; }
  .field select:hover,
  .field-pair input:hover { border-color: var(--border-h, #2A2E48); }
  .field-pair { display: flex; align-items: center; gap: 8px; }
  .field-pair input { width: 100%; min-width: 0; font-variant-numeric: tabular-nums; }
  .field-dash { flex: 0 0 auto; color: var(--text-3); }
  /* Persistent helper text for the two controls whose behaviour is not
     guessable from their label — what "best" weights by, and that the
     duration floor reads the item's real files. Both were tooltips, which
     is to say invisible. */
  .field-help {
    font-size: 11px;
    line-height: 1.45;
    color: var(--text-2);
    opacity: 0.85;
  }

  .toggles { display: flex; flex-wrap: wrap; gap: 8px; }
  .toggle {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 12px 0 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-2) 65%, transparent);
    color: var(--text-2);
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    transition: color 0.14s var(--ease), background 0.14s var(--ease), border-color 0.14s var(--ease);
  }
  /* The native checkbox stays in the DOM for semantics, keyboard and
     screen readers; only its painting is replaced. */
  .toggle input {
    position: absolute;
    width: 1px; height: 1px;
    opacity: 0;
    margin: 0;
  }
  .toggle-box {
    flex: 0 0 auto;
    width: 15px;
    height: 15px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--text-2) 55%, transparent);
    border-radius: 4px;
    color: transparent;
    transition: background 0.14s var(--ease), border-color 0.14s var(--ease), color 0.14s var(--ease);
  }
  .toggle:hover { color: var(--text-1); border-color: var(--border-h, #2A2E48); }
  .toggle:focus-within { outline: 2px solid var(--amber); outline-offset: 2px; }
  .toggle:has(input:checked) {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 12%, transparent);
    border-color: color-mix(in srgb, var(--amber) 45%, transparent);
  }
  .toggle:has(input:checked) .toggle-box {
    background: var(--amber);
    border-color: var(--amber);
    color: var(--bg);
  }

  /* Expanded tag band — the searchable long tail, in place. */
  .band-tags-body {
    flex: 1 1 auto;
    min-width: 0;
    padding-bottom: 4px;
  }
  .tag-cloud {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 132px;
    overflow-y: auto;
    padding: 10px 2px 2px;
  }

  .tag-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    max-width: 320px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-2);
    transition: border-color 0.14s var(--ease);
  }
  .tag-search-wrap:focus-within { border-color: color-mix(in srgb, var(--amber) 60%, transparent); color: var(--amber); }
  .tag-search-icon { display: inline-flex; flex: 0 0 auto; }
  .tag-search-input {
    flex: 1 1 auto;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
    font: inherit;
    font-size: 12.5px;
    color: var(--text-1);
  }
  .tag-search-input::placeholder { color: var(--text-2); opacity: 0.75; }
  .tag-search-input:focus-visible { outline: none; }
  .tag-search-popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    z-index: 30;
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--border-h, #2A2E48);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
  }
  .tag-search-empty { padding: 10px 8px; font-size: 11.5px; color: var(--text-2); }
  .tag-search-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s var(--ease), color 0.1s var(--ease);
  }
  .tag-search-row:hover { background: var(--surface-3); color: var(--text-1); }
  .tag-search-row.active { color: var(--amber); }
  .tag-search-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─── the one chip language ─────────────────────────────────── */
  .chip {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--chip-h);
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--text-2) 26%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-2) 55%, transparent);
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.14s var(--ease), background 0.14s var(--ease),
                border-color 0.14s var(--ease), transform 0.09s var(--ease);
  }
  .chip::before { content: ''; position: absolute; inset: -8px -2px; }
  .chip:hover {
    color: var(--text-1);
    background: color-mix(in srgb, var(--surface-2) 92%, transparent);
    border-color: color-mix(in srgb, var(--text-2) 48%, transparent);
  }
  .chip:active { transform: scale(0.97); }
  .chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 24ch;
  }
  .chip-count {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    opacity: 0.6;
  }

  /* Tags — statistical. Neutral until picked. */
  .chip-tag.on,
  .chip-tag[aria-pressed='true'] {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 18%, transparent);
    border-color: color-mix(in srgb, var(--amber) 60%, transparent);
  }

  /* Editorial — decided by people. Gold: the page's accent belongs to the
     strongest signal it has. */
  .chip-editorial {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 7%, transparent);
    border-color: color-mix(in srgb, var(--amber) 30%, transparent);
  }
  .chip-editorial:hover {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 16%, transparent);
    border-color: color-mix(in srgb, var(--amber) 52%, transparent);
  }
  .chip-editorial.on {
    background: color-mix(in srgb, var(--amber) 26%, transparent);
    border-color: var(--amber);
    font-weight: 600;
  }

  /* Computed rather than curated — a cooler tone so it does not read as
     another editorial list. */
  .chip-computed {
    color: var(--cyan);
    background: color-mix(in srgb, var(--cyan) 7%, transparent);
    border-color: color-mix(in srgb, var(--cyan) 30%, transparent);
  }
  .chip-computed:hover {
    color: var(--cyan);
    background: color-mix(in srgb, var(--cyan) 16%, transparent);
    border-color: color-mix(in srgb, var(--cyan) 52%, transparent);
  }
  .chip-computed.on {
    background: color-mix(in srgb, var(--cyan) 24%, transparent);
    border-color: var(--cyan);
    font-weight: 600;
  }

  /* Active filters. Tinted by where the filter came from, so the row is
     scannable; hovering any of them turns red, because clicking removes. */
  .chip-removable { color: var(--text-1); }
  .chip-removable[data-tone='query'] {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 10%, transparent);
    border-color: color-mix(in srgb, var(--green) 38%, transparent);
  }
  .chip-removable[data-tone='tag'],
  .chip-removable[data-tone='rail'] {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 12%, transparent);
    border-color: color-mix(in srgb, var(--amber) 40%, transparent);
  }
  .chip-removable[data-tone='filter'] {
    color: var(--text-1);
    background: color-mix(in srgb, var(--surface-3) 80%, transparent);
    border-color: color-mix(in srgb, var(--text-2) 34%, transparent);
  }
  .chip-removable:hover {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 13%, transparent);
    border-color: color-mix(in srgb, var(--red) 55%, transparent);
  }
  .chip-mode {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  /* ─── ③ active filters ──────────────────────────────────────── */
  .band-active { padding-bottom: 10px; }
  .active-list {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .linkbtn {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 2px;
    border: 0;
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: color 0.14s var(--ease);
  }
  .linkbtn::before { content: ''; position: absolute; inset: -13px -6px; }
  .linkbtn:hover { color: var(--amber); }

  /* ─── ④⑤ discover + tags ────────────────────────────────────── */
  /* Horizontal scroll instead of wrapping. Thirty tag chips wrapped to
     four rows and took the fold; one row that scrolls holds the same
     content and costs 34px. */
  .band-scroll {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    /* Room for the 2px focus ring + its offset, which overflow:hidden
       would otherwise clip off the top and bottom of a focused chip. */
    padding: 5px 0;
    scroll-padding-inline: 16px;
  }
  .band-scroll::-webkit-scrollbar { display: none; }
  /* Fades the right edge so a cut-off chip reads as "there is more" rather
     than as a clipping bug. Dropped while anything inside has focus, since
     the mask would also fade the focus ring. */
  .band-scroll-fade {
    /* Prefixed as well: unprefixed mask-image only landed in Chrome 120, and
       without the fallback the row hard-cuts mid-chip, which is the exact
       "is this broken?" reading the fade exists to prevent. */
    -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 40px), transparent 100%);
    mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 40px), transparent 100%);
    /* So the last chip can scroll clear of the fade instead of living inside
       it forever. */
    padding-right: 40px;
  }
  .band-scroll-fade:focus-within {
    -webkit-mask-image: none;
    mask-image: none;
  }
  .band-sep {
    flex: 0 0 auto;
    width: 1px;
    height: 16px;
    margin: 0 4px;
    background: var(--line);
  }
  .band-note {
    min-height: 0;
    max-width: 70ch;
    padding-top: 2px;
    padding-bottom: 10px;
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-2);
  }
  .band-rail { padding-bottom: 2px; }
  .band-tags { padding-bottom: 8px; }
  /* Expanded, the band stops being a 40px row: the eyebrow and the collapse
     link stay pinned to the top while the search box and the cloud take the
     height they need. `.band-collapsible` is dropped in the markup while
     this is on, so nothing clips it to 56px. */
  .band-tags-open {
    align-items: flex-start;
    padding-top: 4px;
    padding-bottom: 12px;
  }
  .band-tags-open .eyebrow,
  .band-tags-open .linkbtn { margin-top: 8px; }

  /* ─── condensed on scroll ───────────────────────────────────── */
  /* Once you are reading posters, the two discovery bands fold away and
     the command bar plus the active-filter row stay pinned. Both are one
     scroll-up away, and nothing that reports state is ever hidden. */
  .band-collapsible {
    overflow: hidden;
    max-height: 56px;
    transition: max-height 0.24s var(--ease), opacity 0.18s var(--ease);
  }
  .chrome.condensed .band-collapsible {
    min-height: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    opacity: 0;
    /* Delayed so the band is not pulled out of the tab order mid-animation,
       and so a focused chip inside it does not vanish under the user. */
    visibility: hidden;
    transition:
      max-height 0.24s var(--ease),
      opacity 0.14s var(--ease),
      visibility 0s linear 0.24s;
  }
  .chrome.condensed .band-id { padding-top: 9px; padding-bottom: 7px; }
  .chrome.condensed .wordmark { font-size: 20px; }

  /* ─── responsive ────────────────────────────────────────────── */
  @media (max-width: 860px) {
    .chrome { --gutter: 18px; }
    .band-id { flex-wrap: wrap; }
    .subtitle { order: 3; flex: 1 1 100%; }
    .band-cmd { flex-wrap: wrap; }
    .searchbox { flex: 1 1 100%; }
    .filters-btn { flex: 1 1 auto; justify-content: center; }
  }
  @media (max-width: 620px) {
    .chrome { --gutter: 14px; }
    /* The eyebrow takes its own line rather than eating half the width of
       a 360px viewport. */
    .band-rail, .band-tags, .band-active { flex-wrap: wrap; }
    .eyebrow { flex: 0 0 100%; }
    .band-collapsible { max-height: 92px; }
    .wordmark { font-size: 22px; }
  }

  /* ─── reduced motion ────────────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    .chrome,
    .chrome *,
    .chrome *::before {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
    }
    .caret { opacity: 0.6; }
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
  .result {
    margin: 12px 32px;
    padding: 8px 14px;
    border: 1px dashed var(--green-dim, #4d8a5a);
    border-radius: var(--radius-sm);
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
    padding: 26px 12px 10px;
    /* The scrim starts higher and darker than before. Titles are set in amber
       over whatever the poster happens to be, and on a light frame — a snow
       scene, a title card — the old gradient left them barely legible. */
    background: linear-gradient(
      180deg,
      transparent 0%,
      rgba(0, 0, 0, 0.55) 28%,
      rgba(0, 0, 0, 0.88) 62%,
      rgba(0, 0, 0, 0.97) 100%
    );
    color: #fff;
    pointer-events: none;
  }
  .ovl-title {
    /* Display font on titles — the one place a distinct face earns its
       keep, and what the token set provides Geist for. */
    font-family: var(--font-display);
    color: var(--gold);
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
  /* One line, never wrapping. `min-width: 0` on the children is what lets the
     line clip instead of forcing the row taller — the wrapping version is
     exactly what made every card a different height. */
  .ovl-meta {
    display: flex;
    gap: 0;
    flex-wrap: nowrap;
    align-items: baseline;
    overflow: hidden;
    height: 15px;
    /* Mono here, and only here: years, durations, resolutions and counts are
       exactly the case tabular figures exist for, so columns of cards line
       their numbers up instead of drifting. */
    font-family: var(--font-mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-2);
  }
  .ovl-meta .fact { white-space: nowrap; min-width: 0; }
  /* Interpuncts as separators rather than boxes. Six bordered pills on a
     poster is a fence; six words with dots between them is a caption. */
  .ovl-meta .fact + .fact::before {
    content: "·";
    margin: 0 6px;
    color: var(--green-dim, #4d8a5a);
  }
  .ovl-meta .fact.dl { color: #9dbfa8; }
  /* The year leads the row, so it earns a little weight — it is the fact you
     scan a poster wall by, and at --text-2 it sat level with the resolution
     and the download count. Brighter and bolder, but the same size and the
     same mono figures: the row must still read as one line, not as a badge
     with a caption trailing off it. */
  .ovl-meta .fact.year {
    color: var(--amber, #ffb000);
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  /* Always rendered, even empty, so the grid keeps a single rhythm. */
  .ovl-creator {
    height: 14px;
    margin-top: 2px;
    font-size: 10.5px;
    color: #8fae99;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Quality marks, stacked top-right, clear of the title and of the
     hover buttons on the left. */
  .card-flags {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    max-width: 70%;
    pointer-events: none;
  }
  .flag {
    font-size: 10px;
    line-height: 1;
    letter-spacing: 0.04em;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    backdrop-filter: blur(2px);
  }
  .flag.rail {
    color: #1a1206;
    background: var(--amber, #ffb000);
    font-weight: 700;
  }
  .flag.canon {
    color: #ffe9a8;
    background: rgba(20, 14, 2, 0.82);
    border: 1px solid rgba(255, 176, 0, 0.5);
  }
  .flag.copies {
    color: #cfe0ff;
    background: rgba(8, 14, 28, 0.82);
    border: 1px solid rgba(160, 190, 255, 0.45);
  }
  .flag.bad {
    color: #fff;
    background: rgba(158, 26, 26, 0.92);
    font-weight: 700;
  }
  .ovl-meta .dim { color: #b0c8b8; }

  /* ── Community subtitles, inside the player's caption menu ────────
     Styled to belong to that menu rather than to this page: the menu sits
     over video on a dark translucent panel, so these rows borrow its
     restraint — no borders per row, one line each, the action on the right.
     Global because the markup is passed through a slot into KernlPlayer,
     which puts it outside this component's style scope. */
  /* A panel of its own, not a section that leans on a divider.
     The border-top alone was enough while something sat above it, but when
     the film has no tracks yet this is the only content in the menu and it
     read as a fragment floating over the video. Its own surface, border and
     radius mean it looks deliberate whether it is first or last. */
  :global(.cc-fed) {
    margin-top: 10px;
    padding: 10px 10px 8px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    font-family: var(--font-body);
  }
  :global(.cc-fed-head) {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.45);
    margin-bottom: 6px;
  }
  :global(.cc-fed-refresh) {
    margin-left: auto;
    width: 20px; height: 20px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
  }
  :global(.cc-fed-refresh:hover:not(:disabled)) { color: #F0B429; border-color: #F0B429; }
  :global(.cc-fed-refresh:disabled) { opacity: 0.4; cursor: wait; }

  /* One row per shared track. Language leads because that is what you pick
     by; who made it follows; provider and size are detail and live in the
     tooltip rather than crowding the line. */
  :global(.cc-fed-row) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px;
    border-radius: 5px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.85);
  }
  :global(.cc-fed-row:hover) { background: rgba(255, 255, 255, 0.06); }
  :global(.cc-fed-row.got) { color: rgba(255, 255, 255, 0.5); }
  :global(.cc-fed-lang) {
    font-family: var(--font-mono);
    text-transform: uppercase;
    font-weight: 700;
    font-size: 11px;
    min-width: 22px;
  }
  :global(.cc-fed-who) {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(255, 255, 255, 0.55);
    font-size: 11px;
  }
  :global(.cc-fed-trust) { color: #F0B429; font-size: 11px; }
  :global(.cc-fed-got) { color: #6ee7a0; font-size: 12px; }
  :global(.cc-fed-get) {
    padding: 3px 9px;
    border-radius: 4px;
    border: 1px solid rgba(240, 180, 41, 0.5);
    background: rgba(240, 180, 41, 0.12);
    color: #F0B429;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  :global(.cc-fed-get:hover:not(:disabled)) { background: #F0B429; color: #10131a; }
  :global(.cc-fed-get:disabled) { opacity: 0.35; cursor: not-allowed; }

  :global(.cc-fed-err) { color: #ff9a9a; font-size: 11px; margin: 4px 0; }
  :global(.cc-fed-empty) {
    color: rgba(255, 255, 255, 0.45);
    font-size: 11px;
    line-height: 1.5;
    margin: 4px 0;
  }
  :global(.cc-fed-trustonly) {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
  }
  :global(.cc-fed-trustonly input) { accent-color: #F0B429; cursor: pointer; }

  .similar-row { padding: 10px 0 2px; }
  .similar-head {
    font-size: 11px;
    letter-spacing: 0.08em;
    color: #b0c8b8;
    padding-bottom: 6px;
  }
  /* Horizontal strip: this sits inside a modal whose height is already
     spoken for by the player, so it scrolls sideways rather than pushing
     the video off screen. */
  .similar-strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 6px;
  }
  .similar-card {
    flex: 0 0 104px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    text-align: left;
    color: var(--green, #33ff77);
  }
  .similar-card:hover { border-color: var(--green-dim, #4d8a5a); }
  .similar-card img {
    width: 104px;
    height: 146px;
    object-fit: cover;
    background: #0b1410;
  }
  .similar-title {
    font-size: 11px;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

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

  /* ── Card action toolbar ──────────────────────────────────────────
     One row, one gap value, flush left. The `.play-btn` rules that used to
     live here had no markup left anywhere in the file — but the star was
     still positioned at `left: 48px` to clear it, so every card carried a
     48px indent for a button that no longer existed. */
  .card-actions {
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    z-index: 3;
  }
  /* Shared shell for every control in the bar: same box, same ring, same
     motion. Only the glyph and its accent differ. */
  .card-act {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    /* Opaque enough to hold contrast over a bright poster — at 0.6 the dim
       green washed out completely against a pale frame, which is why the ℹ
       read as "dark and invisible". */
    background: rgba(4, 8, 6, 0.82);
    /* One legible foreground for all three. They were split between bright
       green and a dim #4d8a5a that only cleared 4.5:1 against pure black,
       and these sit over arbitrary artwork. */
    color: #b9f2cc;
    border: 1px solid rgba(185, 242, 204, 0.5);
    /* Sizes were 16 / 14 / 15 with no reason; one token keeps the row even. */
    font-size: 15px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transform: scale(0.85);
    transition: opacity 0.15s ease, transform 0.15s ease, color 0.15s ease,
                border-color 0.15s ease, background 0.15s ease;
  }
  .card:hover .card-act,
  .card:focus-within .card-act { opacity: 1; transform: scale(1); }
  .card-act:hover,
  .card-act:focus-visible {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    background: rgba(0, 0, 0, 0.9);
    outline: none;
  }
  .card-act:focus-visible { outline: 2px solid var(--amber, #ffb000); outline-offset: 2px; }
  /* Saved is a state, so it stays lit even when the card is not hovered —
     otherwise the only way to see your watchlist marks is to sweep the grid. */
  .card-act.saved {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.4);
    opacity: 1;
    transform: scale(1);
  }
  @media (prefers-reduced-motion: reduce) {
    .card-act { transition: opacity 0.15s ease; transform: none; }
    .card:hover .card-act { transform: none; }
  }

  /* ★ watchlist toggle on each card */
  /* The three controls differ only in their accent; the shell lives in
     `.card-act` above so the row cannot drift apart again. */

  /* 📁 add-to-directory — cyan while its popover is the thing you are aiming
     at, so it reads apart from the amber "saved" state next to it. */
  .dir-btn:hover, .dir-btn:focus-visible {
    color: var(--cyan, #4dd0e1);
    border-color: var(--cyan, #4dd0e1);
  }

  /* The film sheet. Wider than the directory dialog because its job is
     reading — a synopsis set in a 460px column at 11px was the complaint. */
  .info-dialog {
    width: min(760px, calc(100vw - 32px));
    max-height: min(86vh, 720px);
    display: flex;
    flex-direction: column;
    background: var(--bg-1, #0a1812);
    border: 1px solid var(--green-dim, #4d8a5a);
    border-radius: var(--radius-sm);
    padding: 14px 18px 12px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.8);
    text-align: left;
  }
  .info-body {
    display: flex;
    gap: 18px;
    padding: 14px 0 4px;
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .info-poster {
    /* 168 → 200 with a fixed 3/4 box. archive.org art arrives at wildly
       different ratios, so an unconstrained <img> made the whole left column
       jump between films; reserving the box also keeps the layout from
       shifting as the image decodes. */
    width: 200px;
    aspect-ratio: 3 / 4;
    object-fit: cover;
    flex: 0 0 auto;
    align-self: flex-start;
    background: #0b1410;
    border: 1px solid var(--line, #1d3a26);
    border-radius: 3px;
  }
  .info-main { min-width: 0; flex: 1 1 auto; }
  .info-title {
    /* 19 → 24. The title was barely larger than the synopsis under it, so the
       card had no clear entry point; hierarchy comes from size and spacing,
       not from colour. */
    margin: 0 0 10px;
    font-family: var(--font-display);
    font-size: 24px;
    line-height: 1.2;
    font-weight: 700;
    color: var(--text-1);
    text-wrap: balance;
    letter-spacing: -0.01em;
  }
  /* Facts as a separated run rather than a paragraph — they are scanned,
     not read. */
  /* Chips instead of a `·`-joined run. "2005 · 1:43:32 · 136p · ⇩354.9k" made
     the reader guess what 136p and 354.9k were; each value now sits in its own
     box with a `title`, and the figures are tabular so they line up. */
  .info-facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
  }
  .info-facts > span {
    padding: 3px 9px;
    border: 1px solid rgba(255, 176, 0, 0.28);
    border-radius: 3px;
    background: rgba(255, 176, 0, 0.07);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: var(--amber, #ffb000);
    white-space: nowrap;
  }
  .info-creator { margin-bottom: 12px; }
  /* 14.5px and 1.65 line-height: this is body copy now, not a tooltip.
     max-width keeps the measure near 70 characters so long synopses stay
     readable instead of running the full dialog width. */
  .info-desc {
    margin: 0 0 10px;
    font-size: 14.5px;
    line-height: 1.65;
    color: #c8e8d2;
    max-width: 62ch;
    white-space: pre-wrap;
  }
  /* Long synopses open collapsed. Clamping at a line boundary beats the old
     1200-character slice, which cut mid-word and offered no way to the rest. */
  .info-desc.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 7;
    line-clamp: 7;
    overflow: hidden;
  }

  /* ── Synopsis toolbar ────────────────────────────────────────────── */
  .desc-bar {
    display: flex; align-items: center; gap: 8px;
    max-width: 62ch;
    margin: 0 0 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(77, 138, 90, 0.22);
  }
  /* Says what you are looking at. Without it a translated synopsis is
     indistinguishable from an original one written in your language. */
  .desc-state {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--green-dim, #4d8a5a);
  }
  .desc-state.on { color: var(--cyan, #4dd0e1); }
  .desc-btn {
    display: inline-flex; align-items: center; gap: 5px;
    min-height: 26px;
    padding: 0 9px;
    border: 1px solid rgba(207, 232, 208, 0.22);
    border-radius: 3px;
    background: rgba(207, 232, 208, 0.05);
    color: #cfe8d0;
    font: 500 11px 'Manrope', sans-serif;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .desc-btn:hover:not(:disabled) {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    background: rgba(255, 176, 0, 0.08);
  }
  .desc-btn:focus-visible { outline: 2px solid var(--amber, #ffb000); outline-offset: 2px; }
  /* Disabled reads as disabled: dimmed AND not-allowed, never a live-looking
     control that ignores you. */
  .desc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .desc-btn.primary {
    border-color: rgba(77, 208, 225, 0.45);
    background: rgba(77, 208, 225, 0.1);
    color: var(--cyan, #4dd0e1);
  }
  .desc-lang {
    min-height: 26px;
    padding: 0 6px;
    border: 1px solid rgba(207, 232, 208, 0.22);
    border-radius: 3px;
    background: var(--bg-1, #0a1812);
    color: #cfe8d0;
    font: 500 11px 'Manrope', sans-serif;
    cursor: pointer;
  }
  .desc-lang:focus-visible { outline: 2px solid var(--amber, #ffb000); outline-offset: 2px; }
  .desc-more { margin: 0 0 12px; }
  .desc-credit { margin: 0 0 12px; }
  /* An LLM call is seconds, not milliseconds — the button has to show it is
     working or people press it again. */
  .desc-spin {
    width: 10px; height: 10px;
    border: 1.5px solid rgba(77, 208, 225, 0.3);
    border-top-color: var(--cyan, #4dd0e1);
    border-radius: 50%;
    animation: desc-spin 0.7s linear infinite;
  }
  @keyframes desc-spin { to { transform: rotate(360deg); } }
  .desc-err {
    display: flex; align-items: center; gap: 8px;
    max-width: 62ch;
    margin: 0 0 10px;
    padding: 7px 10px;
    border: 1px solid rgba(255, 90, 90, 0.4);
    border-radius: 3px;
    background: rgba(255, 90, 90, 0.08);
    color: #ffb3b3;
    font-size: 11.5px;
  }
  .desc-err-x {
    margin-left: auto;
    border: 0; background: none;
    color: inherit; font-size: 15px; line-height: 1;
    cursor: pointer;
  }
  @media (prefers-reduced-motion: reduce) {
    .desc-btn { transition: none; }
    .desc-spin { animation-duration: 2s; }
  }
  .info-tags { display: flex; flex-wrap: wrap; gap: 5px; }
  .info-tags .tag {
    color: #cfe8d0;
    font-size: 11px;
    background: rgba(207, 232, 208, 0.07);
    border: 1px solid rgba(207, 232, 208, 0.18);
    padding: 2px 8px;
    border-radius: 999px;
  }
  .info-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 12px;
    margin-top: 4px;
    border-top: 1px dashed var(--line, #1d3a26);
    flex: 0 0 auto;
  }
  .info-actions .spacer { flex: 1 1 auto; }

  @media (max-width: 640px) {
    .info-body { flex-direction: column; }
    .info-poster { width: 128px; }
  }

  /* Save-to-directory dialog.
     Amber, not the cyan the old popover used — that colour appeared nowhere
     else on the page and read as a foreign element pasted over the grid.
     Amber is already this interface's "you did something" accent (the star,
     the canon badge), which is exactly what filing a film is. */
  .dir-dialog {
    width: min(460px, calc(100vw - 32px));
    max-height: min(80vh, 620px);
    overflow-y: auto;
    background: var(--bg-1, #0a1812);
    border: 1px solid var(--amber, #ffb000);
    border-radius: var(--radius-sm);
    padding: 14px 16px 12px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.8);
    text-align: left;
  }
  .dir-dialog-head {
    display: flex; align-items: center; justify-content: space-between;
    color: var(--amber, #ffb000);
    font-size: 12px;
    letter-spacing: 0.14em;
    padding-bottom: 10px;
    border-bottom: 1px dashed var(--line, #1d3a26);
  }
  /* The film being filed, stated first. The old popover covered it. */
  .dir-dialog-subject {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 12px 0;
  }
  .dir-dialog-subject img {
    width: 48px; height: 68px;
    object-fit: cover;
    background: #0b1410;
    flex: 0 0 auto;
  }
  .dir-dialog-title {
    font-size: 13px;
    line-height: 1.3;
    color: var(--green, #33ff77);
  }

  .dir-dialog-list { list-style: none; padding: 0; margin: 0 0 12px; }
  .dir-dialog-list li button {
    width: 100%;
    display: flex; justify-content: space-between; align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-1, #e5e5e5);
    cursor: pointer;
    font: inherit; font-size: 12px;
    border-radius: var(--radius-sm);
    margin-bottom: 4px;
  }
  .dir-dialog-list li button:hover:not(:disabled) {
    background: rgba(255, 176, 0, 0.12);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
  }
  .dir-dialog-list li button:disabled { opacity: 0.5; cursor: wait; }
  .dir-name { text-align: left; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .dir-dialog-new { display: block; padding-top: 4px; }
  .dir-dialog-new label { display: block; margin-bottom: 6px; line-height: 1.4; }
  .dir-dialog-new-row { display: flex; gap: 6px; }
  .dir-dialog-new-row input {
    flex: 1 1 auto;
    min-width: 0;
    height: 32px;
    box-sizing: border-box;
    padding: 0 10px;
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green, #33ff77);
    font: inherit; font-size: 13px;
    border-radius: var(--radius-sm);
    outline: none;
  }
  .dir-dialog-new-row input:focus {
    border-color: var(--amber, #ffb000);
    box-shadow: 0 0 6px rgba(255, 176, 0, 0.2);
  }
  .dir-dialog-new-row button { flex: 0 0 auto; height: 32px; white-space: nowrap; }

  .dir-dialog-notice {
    font-size: 12px;
    margin-top: 10px;
    color: #ff9a9a;
  }
  .dir-dialog-notice.ok { color: var(--green, #33ff77); }
  .dir-dialog-manage {
    display: block;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px dashed var(--line, #1d3a26);
  }

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
    border-radius: var(--radius-sm);
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
  /* ── Startup preloader ───────────────────────────────────────────
     Same phosphor vocabulary as .cfb-spinner, scaled up: amber on black,
     square corners, monospace. Sits over the whole video area because at
     this point there is nothing underneath it worth seeing. */
  .vboot {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 7;                 /* under the codec banner (8), over the video */
    background:
      radial-gradient(ellipse at center, rgba(255, 176, 0, 0.05), transparent 62%),
      rgba(0, 0, 0, 0.55);
    pointer-events: none;       /* never eat a click meant for the player */
    animation: vboot-in 260ms ease-out;
  }
  @keyframes vboot-in { from { opacity: 0; } to { opacity: 1; } }

  .vboot-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    min-width: 236px;
    padding: 22px 28px;
    background: rgba(8, 5, 0, 0.86);
    border: 1px solid rgba(255, 176, 0, 0.34);
    box-shadow: 0 0 34px rgba(255, 176, 0, 0.13), inset 0 0 40px rgba(255, 176, 0, 0.04);
    font-family: var(--font-mono, ui-monospace), monospace;
  }

  /* Four sprocket bars, chasing. Reads as film running through a gate. */
  .vboot-reel {
    display: flex;
    align-items: flex-end;
    gap: 5px;
    height: 26px;
  }
  .vboot-reel span {
    width: 6px;
    height: 100%;
    background: var(--amber, #ffb000);
    transform-origin: bottom;
    animation: vboot-reel 1.05s ease-in-out infinite;
    box-shadow: 0 0 8px rgba(255, 176, 0, 0.55);
  }
  .vboot-reel span:nth-child(2) { animation-delay: 0.13s; }
  .vboot-reel span:nth-child(3) { animation-delay: 0.26s; }
  .vboot-reel span:nth-child(4) { animation-delay: 0.39s; }
  @keyframes vboot-reel {
    0%, 100% { transform: scaleY(0.28); opacity: 0.45; }
    50%      { transform: scaleY(1);    opacity: 1; }
  }

  .vboot-label {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--amber, #ffb000);
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.45);
  }

  .vboot-bar {
    position: relative;
    width: 100%;
    height: 4px;
    background: rgba(255, 176, 0, 0.13);
    overflow: hidden;
  }
  .vboot-fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 0;
    background: var(--amber, #ffb000);
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.6);
    transition: width 240ms linear;
  }
  /* No real percentage to show — sweep instead of inventing one. */
  .vboot-bar.indeterminate .vboot-fill {
    width: 34%;
    transition: none;
    animation: vboot-sweep 1.25s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }
  @keyframes vboot-sweep {
    0%   { left: -34%; }
    100% { left: 100%; }
  }

  .vboot-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    letter-spacing: 0.06em;
    color: rgba(255, 176, 0, 0.62);
  }
  .vboot-elapsed { font-variant-numeric: tabular-nums; }
  .vboot-sep { opacity: 0.4; }
  .vboot-note { opacity: 0.75; }

  /* Motion is the whole point here, so reduced-motion gets a static, still
     legible card rather than nothing to look at. */
  @media (prefers-reduced-motion: reduce) {
    .vboot { animation: none; }
    .vboot-reel span { animation: none; transform: scaleY(0.7); opacity: 0.8; }
    .vboot-bar.indeterminate .vboot-fill { animation: none; width: 100%; opacity: 0.45; }
  }

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
  /* Probe knew up front — routine routing, not a fault. Same slot, no siren:
     dimmer, no glow, and it says what is happening rather than what broke. */
  .cfb-expected {
    background: rgba(0, 0, 0, 0.72);
    border-color: rgba(255, 176, 0, 0.28);
    color: rgba(255, 176, 0, 0.78);
    box-shadow: none;
    text-shadow: none;
  }
  .cfb-expected::before { content: "> "; opacity: 0.5; }
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
  /* Stack source pills as full-width rows for the SELECT list — each
     option is a clear, tappable row instead of a cramped horizontal
     line of capsules. The Target Language picker overrides this back
     to flex-row via .cfg-row.target-row. */
  .cfg-row.source-row {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  /* Compact pills used in horizontal rows (target language) — keep them
     inline-sized, not full-width. */
  .cfg-row.target-row .src-pill {
    width: auto;
    padding: 9px 14px;
  }

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
    /* 48px of top padding, not 14: the star/folder/info buttons sit at
       `top: 8px` and are 32px tall, so text starting at 14px ran straight
       under them and the first two lines were unreadable. Reserve the row
       instead of stacking on it. */
    padding: 48px 14px 12px;
    /* A column so the tags and the affordance can hold the bottom while the
       paragraph takes whatever is left — previously everything flowed from
       the top and the tags were sliced by the card edge. */
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
    /* Explicit, and below the action buttons' 3. It relied on source order
       before, which is why the buttons drew over the text rather than the
       text simply starting below them. */
    z-index: 1;
    /* A glance, not a read — the ℹ button opens the readable version. Still
       bumped from 11.5px, which was small enough to be decorative. */
    font-size: 12.5px;
    line-height: 1.55;
    pointer-events: none;
    animation: fade 0.18s ease-out;
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .hover-desc .hover-text {
    margin: 0;
    color: #c0e8cd;
    /* Clamp at a LINE boundary with a real ellipsis, and let the box shrink:
       `min-height: 0` is what allows a flex child to give room back to the
       tags below instead of pushing them out of the card. */
    flex: 0 1 auto;
    min-height: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    overflow: hidden;
  }
  /* The tags and the hint own the bottom — pushed there, never overrun. */
  .hover-desc .tags {
    display: flex; gap: 5px; flex-wrap: wrap;
    flex: 0 0 auto;
    margin-top: auto;
    max-height: 44px;
    overflow: hidden;
  }
  .hover-desc .tag {
    color: var(--cyan, #4dd0e1);
    font-size: 10px;
    background: rgba(77, 208, 225, 0.08);
    padding: 1px 6px;
    border-radius: 999px;
    /* One tag with a long name used to wrap into a second line and shove the
       row past the card; keep each to one line. */
    max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Truncation needs a way out, not just an ellipsis. This IS the way out, so
     it has to be clickable — the overlay above sets `pointer-events: none`,
     which every child inherits, so it re-enables them for itself. */
  .hover-desc .hover-more {
    flex: 0 0 auto;
    align-self: flex-start;
    pointer-events: auto;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    /* 28px, not 44: it lives inside a hover-only overlay that no touch device
       ever sees, and a full-size button would eat the card. Generous padding
       keeps it comfortably clickable with a mouse. */
    min-height: 28px;
    padding: 2px 8px;
    border: 1px solid rgba(77, 138, 90, 0.45);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.4);
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--green-dim, #4d8a5a);
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .hover-desc .hover-more:hover {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    background: rgba(0, 0, 0, 0.7);
  }
  .hover-desc .hover-more:focus-visible {
    outline: 2px solid var(--amber, #ffb000);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .hover-desc .hover-more { transition: none; }
  }
  /* Shorter cards can't hold six lines plus tags; drop the clamp so the
     paragraph yields first and the bottom row still fits. */
  @media (max-height: 820px) {
    .hover-desc .hover-text { -webkit-line-clamp: 4; line-clamp: 4; }
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
