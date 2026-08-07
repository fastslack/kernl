<script lang="ts">
  import '../app.css';
  import '$lib/styles/crt.css';
  import { onMount, onDestroy } from 'svelte';
  import { goto, beforeNavigate, afterNavigate } from '$app/navigation';
  import { page } from '$app/stores';
  import { data, wsConnected, storeMap, lastRefresh, ensureStore, activeTheme, type ActiveTheme, notifications, unreadCount, serverTz } from '$lib/stores.js';
  import { wsConnect, wsDisconnect, mergeChannelMap, rpcOrCall, onWsConnected, wsSubscribeChannels, wsUnsubscribeChannels } from '$lib/ws.js';
  import { getChannelsForPage } from '$lib/page-channels.js';
  import { extPages as extPagesStore, extPagesReady } from '$lib/ext-host.js';
  import { NAV_GROUPS, VIEWS, VIEW_TO_GROUP, SUB_TAB_LABELS, type NavGroup, type NavView } from '$lib/constants.js';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import ExtensionGate from '$lib/components/ExtensionGate.svelte';
  import NotificationDropdown from '$lib/components/NotificationDropdown.svelte';
  import ThemeSwitcher from '$lib/components/ThemeSwitcher.svelte';
  import MusicPlayer from '$lib/components/MusicPlayer.svelte';
  import MusicNavIndicator from '$lib/components/MusicNavIndicator.svelte';
  import { displayMode as musicDisplayMode, toggle as musicToggle, next as musicNext, prev as musicPrev, toggleMute as musicToggleMute, setVolume as musicSetVolume, volume as musicVolume, seek as musicSeek, currentTime as musicTime, duration as musicDuration, album as musicAlbum, setDisplayMode as musicSetMode } from '$lib/music-player.js';
  import { initMusicBridge } from '$lib/music-bridge.js';
  import { initLocale } from '$lib/i18n/index.js';
  import { get } from 'svelte/store';

  // ── State ───────────────────────────────────────────────────────
  let serverTimezone = 'UTC'; // default, overridden by /api/health
  let clock = '';
  let clockInterval: ReturnType<typeof setInterval>;
  let cmdOpen = false;
  let notifOpen = false;
  let liveOpen = false;

  // ── LIVE pill popover: the configured LLM chain, with status ─────
  // Hits /api/llm/chain on open. Re-fetches on every open so the user
  // sees the current health (a 403 on Grok between yesterday and now
  // would otherwise be invisible until they opened Settings → AI).
  interface ChainLink {
    slug: string; provider: string; model: string;
    status: 'active' | 'standby' | 'no-key' | 'quota' | 'rate-limit' | 'auth' | 'degraded';
    reason?: string;
    latencyMs?: number;
    blockedForMs?: number;
    lastSuccessAt?: number;
    failures: number;
  }
  let chainData: { primary: ChainLink; fallbacks: ChainLink[] } | null = null;
  let chainErr = '';
  let chainLoading = false;
  async function loadChain() {
    chainLoading = true; chainErr = '';
    try {
      const r = await fetch('/api/llm/chain');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      chainData = await r.json();
    } catch (err) {
      chainErr = err instanceof Error ? err.message : String(err);
      chainData = null;
    } finally { chainLoading = false; }
  }
  function toggleLive() {
    liveOpen = !liveOpen;
    if (liveOpen) loadChain();
  }
  function statusLabel(s: ChainLink['status']): string {
    switch (s) {
      case 'active':     return 'ACTIVE';
      case 'standby':    return 'STANDBY';
      case 'no-key':     return 'NO KEY';
      case 'quota':      return 'NO CREDIT';
      case 'rate-limit': return 'RATE LIMITED';
      case 'auth':       return 'AUTH FAILED';
      case 'degraded':   return 'DEGRADED';
    }
  }
  function fmtSince(epoch?: number): string {
    if (!epoch) return '—';
    const s = Math.round((Date.now() - epoch) / 1000);
    if (s < 60)   return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }
  function fmtCountdown(ms?: number): string {
    if (!ms || ms <= 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60)   return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }
  // Svelte action — closes the popover when the user clicks anywhere
  // outside its wrapper. Inlined here because it's the only consumer.
  function clickOutside(node: HTMLElement, onOutside: () => void) {
    function handle(ev: MouseEvent) {
      if (node && !node.contains(ev.target as Node)) onOutside();
    }
    document.addEventListener('mousedown', handle, true);
    return { destroy() { document.removeEventListener('mousedown', handle, true); } };
  }

  // Manifest-driven navigation — starts with hardcoded defaults, extended by manifest
  let navGroups: NavGroup[] = NAV_GROUPS;
  let allViews: NavView[] = VIEWS;
  let viewToGroup: Record<string, string> = VIEW_TO_GROUP;
  let manifestEndpoints: Array<{ url: string; store: string }> = [];

  // ── Clock ────────────────────────────────────────────────────────
  // The rail clock is split into its own parts rather than reusing the
  // header's single string: 72px of width cannot hold "Thu, Aug 6 04:19:29"
  // on one line, and seconds ticking in the corner of the eye is noise when
  // the point is "what time is it, roughly".
  let railTime = '';
  let railDate = '';

  function updateClock() {
    const now = new Date();
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: serverTimezone });
    const date = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: serverTimezone });
    clock = date + '  ' + time;

    railTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: serverTimezone });
    railDate = now.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: serverTimezone });
  }

  // ── Navigation ───────────────────────────────────────────────────
  $: currentView = $page.url.pathname.split('/')[1] || 'home';
  // System routes that were removed from the sub-tabs but still exist as
  // pages (reached via /system's internal sub-nav or direct URL). Without
  // this fallback they'd highlight the first group and render its tabs.
  const ORPHAN_VIEW_GROUP: Record<string, string> = {
    sysoverview: 'system',
    architecture: 'system',
    providers: 'system',
    'api-registry': 'system',
    'rss-registry': 'system',
    // Instance peering: identity and trusted instances. Lives under System
    // because it is about who this kernel is, not about a person.
    friends: 'system',
    // Scheduled jobs / system agenda. Was a tab under AI ("Auto") reading the
    // same systemAgenda store as /system — a third view of one dataset, filed
    // under the wrong group. Now reached from /system's own sub-nav.
    automations: 'system',
    // Legacy registry, superseded by /extensions (the page says so itself).
    marketplace: 'system',
    // Redirect stubs onto Settings → AI. Kept routable for old bookmarks.
    models: 'system',
    // Pages with no nav item of their own. Both are reached from in-page
    // links, and both were falling through to the old navGroups[0] fallback —
    // which lit up Home and rendered Home's tab bar above them.
    files: 'tools',
    memory: 'ai',
  };
  // Empty string when the view belongs to no group: Chat is pinned to the rail
  // on its own, and a handful of pages are link-only. Defaulting to
  // navGroups[0] made every one of them impersonate Home.
  $: currentGroupId = viewToGroup[currentView] ?? ORPHAN_VIEW_GROUP[currentView] ?? '';

  // Full-bleed pages that need special layout handling. Extension page
  // bundles can also request it via `frontend.pages[].fullBleed`.
  const FULL_BLEED_VIEWS = ['news', 'chat', 'agents-flow', 'architecture', 'mail', 'rss-reader', 'crt-demo', 'cinema', 'books', 'music', 'commander'];
  $: isFullBleed =
    FULL_BLEED_VIEWS.includes(currentView) ||
    $extPagesStore.some((p) => p.view === currentView && p.fullBleed);
  $: currentGroup = navGroups.find(g => g.id === currentGroupId) ?? null;
  // Top-level sub-tabs of the group exclude items declared as children of
  // another view (via manifest `parent` field).
  $: subViews = currentGroup?.views.filter(v => !(v as any).parent) ?? [];
  // Sub-sub-tabs: views whose `parent` matches the currently-open view.
  $: childViews = currentGroup?.views.filter(v => (v as any).parent === currentView) ?? [];
  $: sysGroup = navGroups[navGroups.length - 1];

  // ── Auto-subscribe to page-specific WebSocket channels ──
  let activePageChannels: string[] = [];

  function subscribePageChannels() {
    const path = $page.url.pathname;
    const needed = [...getChannelsForPage(path)];
    // Extension page bundles declare their channels in the manifest
    // (`frontend.pages[].channels`) — merge them for the active view.
    const seg = path.split('/')[1] || '';
    const extPage = get(extPagesStore).find((p) => p.view === seg);
    for (const ch of extPage?.channels ?? []) {
      if (!needed.includes(ch)) needed.push(ch);
    }
    const toUnsub = activePageChannels.filter(ch => !needed.includes(ch));
    if (toUnsub.length > 0) wsUnsubscribeChannels(toUnsub);
    wsSubscribeChannels(needed);
    activePageChannels = needed;
  }

  // Re-subscribe page channels on every navigation
  $: if ($page.url.pathname) subscribePageChannels();

  // Re-subscribe page channels when WS (re)connects
  onWsConnected(() => subscribePageChannels());
  $: mainGroups = navGroups.slice(0, -1);

  // Items may declare a `path` override (absolute URL, possibly with query
  // string). When present, we navigate there instead of the implicit `/${id}`.
  const viewPathOverrides: Record<string, string> = {};

  function navigate(viewId: string) {
    const override = viewPathOverrides[viewId];
    goto(override ?? ('/' + viewId));
    cmdOpen = false;
  }

  // Per-group landing override — sub-tab order stays as-is, but clicking the
  // group icon opens this specific view instead of views[0]. Declared by the
  // group itself (`navGroups[].defaultView` in the manifest); this used to be
  // a hardcoded `{ ai: 'agents-flow' }` map here, so the manifest field was
  // parsed, stored, and never read — an extension could not pick its own
  // landing page. The view still has to exist in the group.
  function navigateGroup(group: NavGroup) {
    const preferred = group.defaultView;
    const landing =
      preferred && group.views.some(v => v.id === preferred)
        ? preferred
        : group.views[0]?.id;
    if (landing) goto('/' + landing);
  }

  // ── Page transition loader ──
  let navigating = false;
  beforeNavigate(() => { navigating = true; });
  afterNavigate(() => { navigating = false; });

  // ── Global fetch interceptor for kernel auth ──────────────────────
  // Most pages call `fetch('/api/...')` directly instead of going through
  // `lib/api.ts`. Patching window.fetch once here injects the bearer token
  // for every same-origin /api/* request without touching 180+ call sites.
  // On 401 we redirect to /login (visible form, sturdier than prompt()).
  if (typeof window !== 'undefined' && !(window as any).__kernelAuthPatched) {
    (window as any).__kernelAuthPatched = true;
    const TOKEN_KEY = 'kernel_auth_token';
    const origFetch = window.fetch.bind(window);
    let redirecting = false; // prevent N parallel 401s from racing N redirects
    window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      // Resolve URL string (Request | URL | string).
      const urlStr = typeof input === 'string' ? input
                   : input instanceof URL    ? input.href
                   : (input as Request).url;
      const isApi = urlStr.startsWith('/api/') || urlStr.includes('://' + location.host + '/api/');
      if (!isApi) return origFetch(input as any, init);

      const token = localStorage.getItem(TOKEN_KEY);
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
      const res = await origFetch(input as any, { ...init, headers });

      // 428 → the kernel has no LLM that can run an agent, and is refusing
      // every feature route until one exists. Same shape as the 401 bounce
      // below, including the guard against N parallel failures racing N
      // redirects. /setup is where it gets fixed, so never bounce off it.
      if (res.status === 428) {
        if (!redirecting && !location.pathname.startsWith('/setup') && !location.pathname.startsWith('/login')) {
          redirecting = true;
          location.href = '/setup?blocked=llm';
        }
        return res;
      }

      if (res.status !== 401) return res;
      // 401 → bounce to /login (carrying ?next= so we come back here).
      // Skip if we're already on /login itself (avoid redirect loops).
      if (!redirecting && !location.pathname.startsWith('/login')) {
        redirecting = true;
        const next = encodeURIComponent(location.pathname + location.search);
        location.href = '/login?next=' + next;
      }
      return res;
    };
  }

  // ── Data fetching ─────────────────────────────────────────────────
  async function safeFetch(url: string) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  /**
   * All dashboard data now arrives via WebSocket channels (mtwRequest publisher).
   * No HTTP polling needed — stores are filled by ws.ts handleMtwMessage().
   * Only fetch data that has no WebSocket channel equivalent.
   */
  async function fetchInitialData() {
    // Fetch init data — uses RPC when WS is connected, falls back to HTTP
    const [skills, marketplace, aiConfig, google, apiReg, rssReg, themeData] = await Promise.allSettled([
      rpcOrCall('skills.list', {}, () => safeFetch('/api/skills')),
      rpcOrCall('marketplace.list', {}, () => safeFetch('/api/marketplace')),
      rpcOrCall('config.ai.get', {}, () => safeFetch('/api/config/ai')),
      rpcOrCall('google.status', {}, () => safeFetch('/api/google/status')),
      rpcOrCall('registry.apis.list', {}, () => safeFetch('/api/registry/apis')),
      rpcOrCall('registry.rss.list', {}, () => safeFetch('/api/registry/rss')),
      rpcOrCall('marketplace.theme.active', {}, () => safeFetch('/api/marketplace/theme/active')),
    ]);

    if (skills.status === 'fulfilled' && skills.value) storeMap['skills'].set(skills.value);
    if (marketplace.status === 'fulfilled' && marketplace.value) storeMap['marketplace'].set(marketplace.value);
    if (aiConfig.status === 'fulfilled' && aiConfig.value) storeMap['aiConfig'].set(aiConfig.value);
    if (google.status === 'fulfilled' && google.value) storeMap['google'].set(google.value);
    if (apiReg.status === 'fulfilled' && apiReg.value) storeMap['apiRegistry'].set(apiReg.value);
    if (rssReg.status === 'fulfilled' && rssReg.value) storeMap['rssRegistry'].set(rssReg.value);
    if (themeData.status === 'fulfilled' && themeData.value?.theme) activeTheme.set(themeData.value.theme as ActiveTheme);

    lastRefresh.set(new Date());
  }

  // Refresh on WS (re)connect — used internally by wsConnect().
  // No UI button: stores are push-driven, a manual refresh is dead UX.
  function onWsRefresh() {
    lastRefresh.set(new Date());
  }

  // ── Notifications ───────────────────────────────────────────────────
  async function fetchNotifications() {
    const r = await rpcOrCall('notifications.list', {}, () => safeFetch('/api/notifications'));
    if (r) {
      const d = r as any;
      notifications.set(d.notifications ?? []);
      unreadCount.set(d.unread ?? 0);
    }
  }

  async function markNotifRead(id: string) {
    await rpcOrCall('notifications.markRead', { id }, () =>
      fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(r => r.json())
    );
    notifications.update(list => list.map(n => n.id === id ? { ...n, read: 1 } : n));
    unreadCount.update(c => Math.max(0, c - 1));
  }

  async function markAllRead() {
    await rpcOrCall('notifications.markAllRead', {}, () =>
      fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(r => r.json())
    );
    notifications.update(list => list.map(n => ({ ...n, read: 1 })));
    unreadCount.set(0);
  }

  function toggleNotif() {
    notifOpen = !notifOpen;
    if (notifOpen) fetchNotifications();
  }

  // ── Command palette ───────────────────────────────────────────────
  $: CMD_ITEMS = allViews.map(v => ({ label: 'Go to ' + v.label, action: () => navigate(v.id) }));

  function openCmd() { cmdOpen = true; }
  function closeCmd() { cmdOpen = false; }

  // ── Key bindings ──────────────────────────────────────────────────
  function handleKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openCmd(); return; }
    if (e.key === 'Escape') {
      closeCmd();
      notifOpen = false;
      // Esc inside fullscreen player → drop to drawer (don't kill playback).
      if (get(musicDisplayMode) === 'fullscreen') musicSetMode('drawer');
      return;
    }
    if (cmdOpen) return;
    if (e.key >= '1' && e.key <= '9' && e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const idx = parseInt(e.key) - 1;
      if (allViews[idx]) navigate(allViews[idx].id);
      return;
    }

    // ── Player hotkeys ─────────────────────────────────────────────
    // Only fire when the user isn't typing into an input/textarea/contenteditable
    // and an album is loaded. Modifiers other than Shift are ignored — anything
    // with Ctrl/Cmd/Alt is reserved for other features.
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!get(musicAlbum)) return;
    switch (e.key) {
      case ' ':         e.preventDefault(); musicToggle(); break;
      case 'ArrowRight':
        if (e.shiftKey) {
          musicSeek(get(musicTime) + 10);
        } else if ((e as any).rawShift !== true) {
          // Plain → next track. Shift → seek +10s.
          musicNext();
        }
        break;
      case 'ArrowLeft':
        if (e.shiftKey) musicSeek(Math.max(0, get(musicTime) - 10));
        else musicPrev();
        break;
      case 'ArrowUp':   e.preventDefault(); musicSetVolume(Math.min(1, get(musicVolume) + 0.05)); break;
      case 'ArrowDown': e.preventDefault(); musicSetVolume(Math.max(0, get(musicVolume) - 0.05)); break;
      case 'm': case 'M': musicToggleMute(); break;
      case 'n': case 'N': musicNext(); break;
      case 'p': case 'P': musicPrev(); break;
      case 'f': case 'F':
        musicSetMode(get(musicDisplayMode) === 'fullscreen' ? 'drawer' : 'fullscreen');
        break;
    }
  }

  // ── Theme injection ───────────────────────────────────────────────────
  // CSS variables are pushed to `:root` so every element (including portalled
  // modals/tooltips outside `.app-shell`) inherits them. `customCss` lets a
  // theme ship arbitrary selectors — scanlines, glows, keyframes — that
  // can't be expressed via variables alone. Both go into <style> tags
  // injected directly into <head> so we sidestep Svelte's CSS preprocessor.
  function ensureStyleEl(id: string): HTMLStyleElement {
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    return el;
  }
  $: if (typeof document !== 'undefined') {
    const t = $activeTheme;
    const varsCss = t?.variables
      ? `:root{${Object.entries(t.variables).map(([k, v]) => `${k}:${v}`).join(';')}}`
      : '';
    ensureStyleEl('theme-vars').textContent = varsCss;
    ensureStyleEl('theme-custom').textContent = t?.customCss ?? '';
    // Reflect the active theme as a body class so non-CSS-var rules can
    // target it (e.g. `body.theme-crt-terminal .foo { ... }`).
    const slugClass = t?.slug ? `theme-${t.slug}` : '';
    document.body.className = document.body.className
      .split(' ').filter((c) => !c.startsWith('theme-')).concat(slugClass ? [slugClass] : []).join(' ').trim();
  }

  // ── Header badges from store ───────────────────────────────────────
  $: taskOverdue = ($data as any)?.tasks?.overdue?.length ?? 0;
  $: commDrafts = ($data as any)?.comms?.kpis?.drafts ?? (storeMap['comms'] as any)?._value?.kpis?.drafts ?? 0;

  // ── Auth bypass for /login ─────────────────────────────────────
  // The login page must render in a clean shell (no nav, no WS, no
  // dashboard fetches) — every one of those calls /api which would
  // 401 and bounce us right back into a redirect loop with the
  // interceptor above. Detect early and short-circuit both the init
  // chain in onMount and the shell template at the bottom.
  $: isLoginPage = $page.url.pathname.startsWith('/login');
  // Setup wizard renders its own shell-less view (no sidebar/header) so
  // first-run users aren't distracted by the rest of the dashboard while
  // making config decisions.
  //
  // Important: this is NOT the same as `isFullBleed` declared above —
  // `isFullBleed` toggles inner padding for views like agents-flow that
  // still want the app-shell. `isStandalonePage` skips the app-shell
  // entirely. Conflating them broke agents-flow / news / chat / mail
  // (the .main-content lost its full-bleed-mode class and collapsed to
  // height 0).
  $: isSetupPage = $page.url.pathname.startsWith('/setup');
  $: isStandalonePage = isLoginPage || isSetupPage;

  // ── Manifest-driven route guard ─────────────────────────────────
  // Any URL can be typed directly even if the extension that owns that
  // view is not installed/active (the routes are statically built). If
  // the first path segment is neither a core route nor a view granted by
  // the manifest, render <ExtensionGate/> instead of the page.
  //
  // Fail-open by design: until the first successful manifest fetch
  // (`manifestReady`), nothing is blocked — this avoids flashing the gate
  // on legitimate loads and keeps the dashboard usable if /api/manifest
  // is down.
  let manifestReady = false;

  // Core routes that are ALWAYS allowed regardless of the manifest.
  const CORE_ROUTES = new Set([
    'settings', 'system', 'sysoverview', 'architecture', 'extensions',
    'notifications', 'marketplace', 'setup', 'welcome', 'login', 'chat',
    'commander', 'agents', 'agents-flow', 'workspace', 'files', 'models',
    'providers', 'memory', 'skills',
    'autogenesis', 'issues',
    // Instance peering. Core, not an extension: it is how this kernel knows
    // who it is and which other instances it trusts.
    'friends',
  ]);

  // Views granted by nav (hardcoded NAV_GROUPS base + manifest navItems),
  // plus the first segment of any manifest `path` override so items that
  // point at a custom URL keep that route reachable too.
  $: allowedViews = new Set<string>([
    ...allViews.map((v) => v.id),
    // Views served by extension page bundles are allowed even when they
    // have no nav item of their own.
    ...$extPagesStore.map((p) => p.view),
    ...Object.values(viewPathOverrides)
      .map((p) => (p.split('?')[0].split('/')[1] ?? ''))
      .filter((seg) => seg !== ''),
  ]);

  $: routeSegment = $page.url.pathname.split('/')[1] || '';
  $: routeGated =
    manifestReady &&
    !isStandalonePage &&
    routeSegment !== '' &&
    !CORE_ROUTES.has(routeSegment) &&
    !allowedViews.has(routeSegment);

  // ── Lifecycle ────────────────────────────────────────────────────
  //
  // The shell's init (manifest, WebSocket, clock, notifications) is split out
  // of onMount so it can also run when we *leave* a standalone page without a
  // full page load.
  //
  // Why that matters: on a fresh install every /api/* route answers 428 until
  // an LLM is configured, and the fetch interceptor above turns that into a
  // hard `location.href = '/setup'`. The app therefore boots *at* /setup, the
  // init is skipped, and the wizard's closing `goto()` is a client-side
  // navigation that never remounts this layout. The result was a dashboard
  // with no manifest — sidebar stuck on the two hardcoded base groups, so the
  // rail showed a single "Social" icon — no WebSocket, no clock and no data,
  // until the user pressed F5. Running init on the standalone→shell transition
  // is what makes that first paint correct.
  let shellInitialized = false;
  let mounted = false;

  onMount(() => {
    mounted = true;
    // Resolve the saved language before anything else. This used to be called
    // from /login only, so any hard load that did not pass through the login
    // page — a bookmark, a refresh, a deep link — left the store on its "en"
    // default and rendered the whole dashboard in English no matter what the
    // user had chosen. Extension pages inherit the same value through
    // ExtPageContext.locale, so they were mistranslated for the same reason.
    // initLocale() reads localStorage first and is a no-op on repeat calls
    // beyond re-setting the same value, so /login calling it too is harmless.
    initLocale();
    if (!isStandalonePage) initShell();
  });

  // Leaving /login or /setup without a page load → initialize now. Gated on
  // `mounted` so init never runs before the router is live (it calls goto()).
  $: if (mounted && !isStandalonePage && !shellInitialized) initShell();

  function initShell() {
    if (shellInitialized) return;
    shellInitialized = true;
    // First-run redirect to the setup wizard — fire-and-forget, do NOT
    // early-return. The layout still needs to fetch the manifest, set
    // up the clock, and open the WebSocket so when the user dismisses
    // the wizard (or lands on it directly) the rest of the dashboard
    // is fully initialized.
    //
    // We respect either flag:
    //   kernl.setupComplete — new wizard at /setup
    //   kernl.welcomeSeen   — legacy welcome flag (kept for users
    //                             who already dismissed the old welcome)
    try {
      const setupDone   = localStorage.getItem('kernl.setupComplete');
      const welcomeSeen = localStorage.getItem('kernl.welcomeSeen');
      const path        = window.location.pathname;
      const onSetupFlow = path === '/setup' || path === '/welcome';
      if (!setupDone && !welcomeSeen && !onSetupFlow) {
        goto('/setup', { replaceState: true });
      }
    } catch {
      /* localStorage disabled (privacy mode, sandboxed iframe) — skip the
         redirect rather than block the dashboard. */
    }

    // ── Is there an LLM that can run an agent? ──────────────────────
    //
    // Asked up front so a blocked install lands on the screen that fixes it
    // instead of on a dashboard whose every panel fails one by one. The 428
    // handler on window.fetch is the backstop for anything that slips past;
    // this is what makes the first paint correct.
    //
    // Deliberately NOT keyed off localStorage the way the first-run redirect
    // above is: a flag in the browser is not evidence about the server, and
    // clearing it was all it took to walk past that one.
    fetch('/api/llm/readiness')
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { ok?: boolean } | null) => {
        if (v && v.ok === false && !window.location.pathname.startsWith('/setup')) {
          goto('/setup?blocked=llm', { replaceState: true });
        }
      })
      .catch(() => {
        /* Kernel unreachable — the existing offline handling covers it; a
           readiness verdict we could not fetch is not evidence of anything. */
      });

    // Fetch server timezone before starting clock
    rpcOrCall('server.health', {}, () => fetch('/api/health').then(r => r.json())).then((d: any) => {
      if (d?.timezone) { serverTimezone = d.timezone; serverTz.set(d.timezone); }
      updateClock();
    }).catch(() => {});
    updateClock();
    clockInterval = setInterval(updateClock, 1000);

    // Google OAuth redirect handling
    const qs = new URLSearchParams(window.location.search);
    const googleAuth = qs.get('google_auth');
    if (googleAuth) {
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
      const msg = googleAuth === 'success'
        ? { text: '✓ Google connected successfully', bg: 'var(--green)', col: 'var(--bg)' }
        : { text: '⚠ Google auth failed: ' + (qs.get('error') || 'Unknown error'), bg: 'var(--red)', col: '#fff' };
      setTimeout(() => {
        const banner = document.createElement('div');
        banner.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);background:${msg.bg};color:${msg.col};padding:10px 24px;border-radius:8px;font-weight:600;font-size:14px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.3)`;
        banner.textContent = msg.text;
        document.body.appendChild(banner);
        setTimeout(() => banner.remove(), 4000);
      }, 500);
    }

    // Evict any residual service worker left behind from a previous PWA
    // build of this dashboard. Those SWs keep serving stale chunks and
    // trigger "new version available" banners on every navigation because
    // their cached /_app/version.json drifts away from what the server sends.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => {});
    }

    refreshManifest();
    // Re-apply the manifest whenever an extension is enabled/disabled/uninstalled.
    // The /extensions page dispatches this event after each mutation.
    onManifestChangeRef = () => refreshManifest();
    window.addEventListener('manifest:refresh', onManifestChangeRef);

    // Bridge the global music player to the kernl: event bus so the
    // migrated /music extension page can drive it (see $lib/music-bridge).
    musicBridgeDispose = initMusicBridge();

    wsConnect(onWsRefresh);
    // Re-fetch init data on every WS (re)connect — covers restart/502 scenarios
    onWsConnected(() => {
      // Re-apply the manifest too: if the very first fetch failed (kernel not
      // ready on first install), this self-heals the sidebar the moment the
      // kernel comes up, without waiting for a manual refresh.
      if (!manifestReady) refreshManifest();
      fetchInitialData();
      fetchNotifications();
    });
    // Also try immediately (works when HTTP is already up)
    fetchInitialData();
    fetchNotifications();
  }

  onDestroy(() => {
    clearInterval(clockInterval);
    wsDisconnect();
    if (typeof window !== 'undefined' && onManifestChangeRef) {
      window.removeEventListener('manifest:refresh', onManifestChangeRef);
    }
    musicBridgeDispose?.();
  });
  // Non-reactive reference so onDestroy can reach the handler.
  let onManifestChangeRef: (() => void) | null = null;
  let musicBridgeDispose: (() => void) | null = null;

  /**
   * Re-fetch /api/manifest and rebuild the sidebar (groups + items).
   * Always starts from the hardcoded base (NAV_GROUPS) so disabled
   * extensions disappear — never accumulate stale items.
   *
   * Bypasses the WS rpc path on purpose: the Rust bridge caches
   * `server.manifest` results, so an enable/disable round-trip would
   * hand us a stale manifest. Going through HTTP with a cache-busting
   * query string guarantees a fresh read every time.
   */
  // Guard so overlapping retry timers don't stack.
  let manifestRetryTimer: ReturnType<typeof setTimeout> | null = null;

  async function refreshManifest(): Promise<void> {
    const manifest = await safeFetch('/api/manifest?_t=' + Date.now());
    if (!manifest) {
      // The kernel is often still booting when the dashboard container comes
      // up on first install (manifest 502/unreachable for ~15-30s). Without a
      // retry the sidebar stays stuck on the hardcoded base groups (only
      // "Social") forever — the extension-driven groups (Home, Work, Finance,
      // Wellness, AI, Tools…) never appear until a manual page refresh.
      // Retry with backoff until the manifest lands.
      if (!manifestReady && !manifestRetryTimer) {
        manifestRetryTimer = setTimeout(() => {
          manifestRetryTimer = null;
          void refreshManifest();
        }, 2500);
      }
      return; // fail-open (no route gating) until a manifest arrives
    }
    if (manifestRetryTimer) { clearTimeout(manifestRetryTimer); manifestRetryTimer = null; }
    const m = manifest as any;

    // 1. Create stores declared by manifest
    if (m.stores) {
      for (const name of m.stores) ensureStore(name);
    }

    // 2. Extend WS channel→store mapping
    if (m.wsChannelMap) {
      mergeChannelMap(m.wsChannelMap);
    }

    // 3. Save manifest fetch endpoints for use in fetchAll
    if (m.fetchEndpoints) {
      manifestEndpoints = m.fetchEndpoints;
    }

    // Installed/active modules — used to hide nav items whose backing
    // feature isn't present (suite stubs declare nav for paid or
    // not-yet-installed features via `requires`). Safe-by-default: an item
    // shows unless it explicitly declares a `requires` module that's absent.
    const installedModules = new Set<string>(Array.isArray(m.modules) ? m.modules : []);

    // 4. Rebuild nav groups + items from scratch (hardcoded base + manifest)
    let nextGroups: NavGroup[] = NAV_GROUPS.map(g => ({
      ...g,
      views: [...g.views],
    }));
    const viewPaths: Record<string, string> = {};

    if (m.navGroups?.length) {
      const existingIds = new Set(nextGroups.map(g => g.id));
      const added: NavGroup[] = [];
      for (const g of m.navGroups) {
        if (existingIds.has(g.id)) continue;
        added.push({
          id: g.id,
          label: g.label,
          icon: g.icon,
          views: [],
          defaultView: g.defaultView,
          order: (g as any).order,
        } as NavGroup);
      }
      if (added.length > 0) {
        const withOrder = nextGroups.map(g => ({
          ...g,
          order:
            (g as any).order ??
            (g.id === 'system' ? 9999 : g.id === 'people' ? 250 : 500),
        }));
        nextGroups = [...withOrder, ...added].sort(
          (a, b) => (((a as any).order ?? 500) - ((b as any).order ?? 500))
        );
      }
    }

    if (m.navItems?.length) {
      for (const item of m.navItems) {
        // Only show items whose backing module is installed. Items without a
        // `requires` always show (never hides a legit feature); items that
        // name an absent module (paid extras, unbuilt stubs) are dropped.
        if (item.requires && !installedModules.has(item.requires)) continue;
        // Fail open, like the manifest gate above. Dropping an item because its
        // group has not been merged yet hides real features with no trace: the
        // nav silently collapsed to the three hardcoded base groups and 39 of
        // 42 items vanished. An item that names an unknown group now creates
        // it rather than disappearing.
        let group = nextGroups.find(g => g.id === item.group);
        if (!group) {
          // Needs an icon and a readable label: without them the sidebar
          // rendered the literal text "undefined" above the group.
          group = {
            id: item.group,
            label: item.group.charAt(0).toUpperCase() + item.group.slice(1),
            icon: '⚙️',
            views: [],
            order: 500,
          } as any;
          nextGroups.push(group);
        }
        if (group.views.find(v => v.id === item.id)) continue;
        const view: any = { id: item.id, label: item.label, icon: item.icon };
        if (item.parent) view.parent = item.parent;
        if (item.order !== undefined) view.order = item.order;
        group.views.push(view);
        if (item.path) viewPaths[item.id] = item.path;
      }
      for (const g of nextGroups) {
        g.views.sort((a, b) => ((a as any).order ?? 999) - ((b as any).order ?? 999));
      }
    }

    // Drop groups left empty after filtering (all their items required an
    // absent module) so no dead group icon lingers in the sidebar. The
    // `system` group is always kept — it's the admin surface (Settings,
    // Extensions, Marketplace) needed to install more, and never empties.
    nextGroups = nextGroups.filter(g => g.id === 'system' || g.views.length > 0);

    // 5. Publish extension page bundles for the [...ext] host route.
    extPagesStore.set(Array.isArray(m.extPages) ? m.extPages : []);
    extPagesReady.set(true);

    navGroups = nextGroups;
    allViews = nextGroups.flatMap(g => g.views);
    const v2g: Record<string, string> = {};
    for (const g of nextGroups) for (const v of g.views) v2g[v.id] = g.id;
    viewToGroup = v2g;
    // Rewrite path overrides: start fresh so removed items don't linger.
    for (const k of Object.keys(viewPathOverrides)) delete viewPathOverrides[k];
    for (const k of Object.keys(viewPaths)) viewPathOverrides[k] = viewPaths[k];
    // First successful manifest load → the route guard may now engage.
    // (Set last: `allViews` above already reflects the granted views, so
    // the guard never evaluates against a stale nav state.)
    manifestReady = true;
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<svelte:head>
  {#if $activeTheme?.fonts?.length}
    {#each $activeTheme.fonts as fontUrl}
      <link rel="stylesheet" href={fontUrl} />
    {/each}
  {/if}
</svelte:head>

{#if isStandalonePage}
  <slot />
{:else}
<div class="app-shell">
  <!-- Header -->
  <header class="header">
    <div class="header-logo">
      <img class="header-logo-img" src="/mascot.png" alt="Kernl" />
    </div>
    <!-- The clock lives at the foot of the rail now, where it is always in
         the same place regardless of which page is open. Repeating it here,
         alongside a greeting, spent the most valuable strip of the screen on
         something neither actionable nor changing. -->
    <div class="header-right">
      <!-- Status cluster: live state of the kernel (tasks pending, mail drafts) -->
      <div class="hdr-cluster hdr-status">
        <button class="header-icon-btn" on:click={() => navigate('tasks')} title="Tasks {taskOverdue > 0 ? '— ' + taskOverdue + ' overdue' : ''}">
          ☑
          {#if taskOverdue > 0}
            <span class="header-icon-badge hb-visible">{taskOverdue}</span>
          {/if}
        </button>
        <button class="header-icon-btn" on:click={() => navigate('comms')} title="Comms {commDrafts > 0 ? '— ' + commDrafts + ' drafts' : ''}">
          ✉
          {#if commDrafts > 0}
            <span class="header-icon-badge hb-visible hb-gold">{commDrafts}</span>
          {/if}
        </button>
        <NotificationDropdown
          open={notifOpen}
          notifications={$notifications}
          unreadCount={$unreadCount}
          on:toggle={toggleNotif}
          on:markRead={(e) => markNotifRead(e.detail.id)}
          on:markAllRead={markAllRead}
          on:viewAll={() => { notifOpen = false; navigate('notifications'); }}
        />
      </div>

      <!-- Music indicator (only visible while an album is loaded). -->
      <MusicNavIndicator />

      <!-- Action cluster: things the user actively reaches for -->
      <div class="hdr-cluster hdr-actions">
        <button class="search-trigger" on:click={openCmd}>
          <span class="search-icon" aria-hidden="true">⌕</span>
          <span class="search-label">Search</span>
          <kbd>⌘K</kbd>
        </button>
      </div>

      <!-- Meta cluster: connection + theme. Compact, low-attention. -->
      <div class="hdr-cluster hdr-meta">
        <div class="live-pill-wrap" use:clickOutside={() => { liveOpen = false; }}>
          <button
            type="button"
            class="ws-pill ws-pill-btn"
            class:connected={$wsConnected}
            class:open={liveOpen}
            on:click={toggleLive}
            title="Realtime stream + LLM chain status — click to inspect"
          >
            <span class="ws-dot"></span>
            <span class="ws-label">{$wsConnected ? 'LIVE' : 'POLL'}</span>
          </button>
          {#if liveOpen}
            <div class="live-popover" role="dialog" aria-label="LLM chain status">
              <header class="lp-head">
                <span class="lp-title">LLM chain · Settings → AI</span>
                <button type="button" class="lp-refresh" on:click={loadChain} title="Re-check provider health" disabled={chainLoading}>
                  ↻
                </button>
              </header>
              {#if chainLoading && !chainData}
                <div class="lp-empty">loading…</div>
              {:else if chainErr}
                <div class="lp-empty lp-err">error: {chainErr}</div>
              {:else if !chainData}
                <div class="lp-empty">no chain configured</div>
              {:else}
                <ul class="lp-list">
                  {#each [chainData.primary, ...chainData.fallbacks] as link, i (link.slug + ':' + i)}
                    <li class="lp-row" data-status={link.status}>
                      <span class="lp-rank">{i === 0 ? 'P' : i}</span>
                      <span class="lp-slug">{link.slug}</span>
                      <span class="lp-model" title={link.model}>{link.model || '—'}</span>
                      <span class="lp-status" data-status={link.status}>{statusLabel(link.status)}</span>
                      <span class="lp-meta">
                        {#if link.latencyMs !== undefined}
                          <span class="lp-meta-item">{Math.round(link.latencyMs)}ms</span>
                        {/if}
                        {#if link.lastSuccessAt}
                          <span class="lp-meta-item" title="Last successful call">✓ {fmtSince(link.lastSuccessAt)}</span>
                        {/if}
                        {#if link.blockedForMs && link.blockedForMs > 0}
                          <span class="lp-meta-item lp-meta-warn" title="Blocked — backoff window">retry in {fmtCountdown(link.blockedForMs)}</span>
                        {/if}
                      </span>
                      {#if link.reason}
                        <span class="lp-reason">{link.reason}</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
                <footer class="lp-foot">
                  <!-- /models is a redirect stub onto the AI section of
                       Settings; link the real destination. -->
                  <a href="/settings?section=ai" on:click={() => liveOpen = false}>configure in Settings →</a>
                </footer>
              {/if}
            </div>
          {/if}
        </div>
        <ThemeSwitcher />
      </div>
    </div>
  </header>

  <!-- Sidebar: one icon per group (vanilla style) -->
  <nav class="sidebar">
    <div class="nav">
      {#each mainGroups as group}
        <button
          class="nav-item"
          class:active={currentGroupId === group.id}
          on:click={() => navigateGroup(group)}
          title={group.label}
        >
          <span class="nav-icon">{group.icon}</span>
          <span class="nav-label">{group.label}</span>
          {#if group.id === 'work' && taskOverdue > 0}
            <span class="nav-badge nb-red">{taskOverdue}</span>
          {:else if group.id === 'people' && commDrafts > 0}
            <span class="nav-badge nb-gold">{commDrafts}</span>
          {/if}
        </button>
      {/each}

      <div style="flex:1"></div>

      <!-- Chat shortcut — pinned above system, visually differentiated -->
      <button
        class="nav-item nav-item-chat"
        class:active={currentView === 'chat'}
        on:click={() => navigate('chat')}
        title="Chat"
      >
        <span class="nav-icon">💬</span>
        <span class="nav-label">Chat</span>
      </button>

      <!-- System group pinned at bottom -->
      <button
        class="nav-item"
        class:active={currentGroupId === sysGroup.id}
        on:click={() => navigateGroup(sysGroup)}
        title={sysGroup.label}
      >
        <span class="nav-icon">{sysGroup.icon}</span>
        <span class="nav-label">{sysGroup.label}</span>
      </button>

      <!-- Clock, pinned below everything.
           Clicking it goes to the planner, same as the header clock — a date
           on screen that does nothing when you press it is a small lie. -->
      <button
        class="rail-clock"
        on:click={() => navigate('planner')}
        title={clock}
        aria-label={`Ir a la agenda — ${clock}`}
      >
        <span class="rail-clock-time">{railTime}</span>
        <span class="rail-clock-date">{railDate}</span>
      </button>

    </div>
  </nav>

  <!-- Main content with sub-tabs -->
  <main class="main-content" class:full-bleed-mode={isFullBleed}>
    {#if subViews.length > 1 && currentView !== 'chat'}
      <div class="sub-tabs">
        {#each subViews as view}
          <button
            class="sub-tab"
            class:active={currentView === view.id}
            on:click={() => navigate(view.id)}
          >
            {SUB_TAB_LABELS[view.id] ?? view.label}
          </button>
        {/each}
      </div>
    {/if}
    {#if childViews.length > 0}
      <div class="sub-tabs sub-tabs-children">
        {#each childViews as view}
          <button
            class="sub-tab child"
            on:click={() => navigate(view.id)}
          >
            {view.icon ?? ''} {view.label}
          </button>
        {/each}
      </div>
    {/if}
    {#if navigating}
      <div style="position:absolute;top:0;left:0;right:0;height:2px;z-index:999;overflow:hidden">
        <div style="height:100%;background:var(--teal,#3dd6c8);animation:pageLoad 0.8s ease-in-out infinite;transform-origin:left"></div>
      </div>
    {/if}
    <div class="main-inner" class:navigating-fade={navigating}>
      {#if routeGated}
        <ExtensionGate />
      {:else}
        <slot />
      {/if}
    </div>
  </main>
</div>

<!-- Command Palette -->
<CommandPalette
  open={cmdOpen}
  commands={CMD_ITEMS}
  on:close={closeCmd}
  on:select={(e) => { e.detail.command.action(); closeCmd(); }}
/>
{/if}

<!--
  Music player — mounted at the ROOT (outside the {#if isStandalonePage} +
  app-shell) so playback survives login/logout, full-bleed views, and route
  transitions. The component handles its own visibility via `displayMode`.
-->
<MusicPlayer />

