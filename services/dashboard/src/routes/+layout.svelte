<script lang="ts">
  import '../app.css';
  import { onMount, onDestroy, tick } from 'svelte';
  import { goto, beforeNavigate, afterNavigate } from '$app/navigation';
  import { page } from '$app/stores';
  import { data, lastRefresh, ensureStore, activeTheme, notifications, unreadCount, serverTz } from '$lib/stores.js';
  import { wsConnect, wsDisconnect, mergeChannelMap, rpcOrCall, onWsConnected, wsSubscribeChannels, wsUnsubscribeChannels } from '$lib/ws.js';
  import { getChannelsForPage } from '$lib/page-channels.js';
  import { extPages as extPagesStore, extPagesReady } from '$lib/ext-host.js';
  import { NAV_GROUPS, VIEWS, VIEW_TO_GROUP, SUB_TAB_LABELS, type NavGroup, type NavView } from '$lib/constants.js';
  import { railViewsFor, buildNav } from '$lib/nav.js';
  import SideNav from '$lib/components/SideNav.svelte';
  import type { SideNavItem } from '$lib/components/SideNav.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import ExtensionGate from '$lib/components/ExtensionGate.svelte';
  import NotificationDropdown from '$lib/components/NotificationDropdown.svelte';
  import ThemeSwitcher from '$lib/components/ThemeSwitcher.svelte';
  import MusicPlayer from '$lib/components/MusicPlayer.svelte';
  import MusicNavIndicator from '$lib/components/MusicNavIndicator.svelte';
  import LlmChainPill from '$lib/components/LlmChainPill.svelte';
  import UpdateProgress from '$lib/components/UpdateProgress.svelte';
  import { initMusicBridge } from '$lib/music-bridge.js';
  import { initLocale, t } from '$lib/i18n/index.js';
  import { get } from 'svelte/store';
  import {
    updateInfo, updating, updateError, updateHint, updateNotice, showUpdateBanner,
    canApplyUpdate, initUpdateStore, refreshUpdateInfo, applyUpdate, dismissUpdate,
  } from '$lib/update.js';
  import { installAuthFetch } from '$lib/auth-fetch.js';
  import { safeFetch, fetchInitialData } from '$lib/bootstrap-data.js';
  import { fetchNotifications, markNotifRead, markAllNotifsRead } from '$lib/notifications.js';
  import { handleShellKeydown } from '$lib/hotkeys.js';
  import { applyTheme } from '$lib/theme.js';
  import { redirectFirstRun, showGoogleAuthBanner, evictServiceWorkers } from '$lib/shell-init.js';

  // ── State ───────────────────────────────────────────────────────
  let serverTimezone = 'UTC'; // default, overridden by /api/health
  let clock = '';
  let clockInterval: ReturnType<typeof setInterval>;
  let cmdOpen = false;
  let notifOpen = false;

  // Manifest-driven navigation — starts with hardcoded defaults, extended by manifest
  let navGroups: NavGroup[] = NAV_GROUPS;
  let allViews: NavView[] = VIEWS;
  let viewToGroup: Record<string, string> = VIEW_TO_GROUP;

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
    // Redirect stubs. Siguen ruteables para bookmarks viejos.
    sysoverview: 'system',
    automations: 'system',
    // Legacy registry, superseded by /extensions (the page says so itself).
    marketplace: 'system',
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
  const FULL_BLEED_VIEWS = ['news', 'chat', 'agents-flow', 'architecture', 'mail', 'rss-reader', 'cinema', 'books', 'music', 'commander'];
  $: isFullBleed =
    FULL_BLEED_VIEWS.includes(currentView) ||
    $extPagesStore.some((p) => p.view === currentView && p.fullBleed);
  $: currentGroup = navGroups.find(g => g.id === currentGroupId) ?? null;
  // Top-level sub-tabs of the group exclude items declared as children of
  // another view (via manifest `parent` field).
  $: subViews = currentGroup?.views.filter(v => !(v as any).parent) ?? [];
  // Rail lateral: los hermanos de la vista abierta. Reemplaza tanto la fila
  // `childViews` (que solo existía parada en el padre y nunca marcaba el item
  // activo) como las tres copias de `.sys-subnav` que cada página se pintaba.
  $: railViews = railViewsFor(currentGroup?.views ?? [], currentView);
  $: railItems = railViews.map((v): SideNavItem => ({
    id: v.id,
    label: viewLabel(v),
    icon: v.icon,
  }));
  $: sysGroup = navGroups[navGroups.length - 1];

  // ── Nav labels ──────────────────────────────────────────────────
  // Group and view labels arrive from manifests as plain English strings —
  // `navItemSchema.label` is a bare z.string(), unlike the settings fields next
  // to it, which are localizable. So the shell translates them by id here and
  // falls back to whatever the manifest said when a key is missing, which is
  // what keeps a freshly installed third-party extension readable instead of
  // rendering a raw key at the user.
  //
  // Groups and views live in separate key spaces on purpose: the id sets
  // overlap (`work` is a group AND a view inside it).
  function labelFor(key: string, fallback: string): string {
    const out = $t(key);
    return out === key ? fallback : out;
  }
  $: groupLabel = (g: { id: string; label: string }) => labelFor(`nav.group.${g.id}`, g.label);
  $: viewLabel = (v: { id: string; label: string }) =>
    labelFor(`nav.view.${v.id}`, SUB_TAB_LABELS[v.id] ?? v.label);


  // ── Header tab rail ─────────────────────────────────────────────
  // The group's tabs live in the header now, in the band that used to sit
  // empty between the logo and the right-hand clusters. A group can carry
  // eight of them (Social) so the track scrolls; the fades below tell the
  // user there is more in that direction, since the scrollbar is hidden.
  $: headerTabs = currentView !== 'chat' && subViews.length > 1 ? subViews : [];
  let tabRailEl: HTMLElement | null = null;
  let railFadeL = false;
  let railFadeR = false;

  function updateRailFades() {
    if (!tabRailEl) { railFadeL = railFadeR = false; return; }
    const { scrollLeft, scrollWidth, clientWidth } = tabRailEl;
    railFadeL = scrollLeft > 1;
    railFadeR = scrollLeft + clientWidth < scrollWidth - 1;
  }

  // Keep the active tab visible: on a narrow window the current view can sit
  // off-screen inside the track, which reads as "this group has no active tab".
  async function syncRail() {
    await tick();
    if (!tabRailEl) return;
    tabRailEl.querySelector('.tabrail-tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateRailFades();
  }
  $: currentView, headerTabs, syncRail();

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
  // Installed while this script initializes, not in onMount: children mount
  // (and fetch) before the layout's onMount runs. See $lib/auth-fetch.
  installAuthFetch(() => void refreshLlmReadiness());

  // Refresh on WS (re)connect — used internally by wsConnect().
  // No UI button: stores are push-driven, a manual refresh is dead UX.
  function onWsRefresh() {
    lastRefresh.set(new Date());
  }

  // ── Notifications ───────────────────────────────────────────────────
  function toggleNotif() {
    notifOpen = !notifOpen;
    if (notifOpen) fetchNotifications();
  }

  // ── Command palette ───────────────────────────────────────────────
  $: CMD_ITEMS = allViews.map(v => ({ label: 'Go to ' + v.label, action: () => navigate(v.id) }));

  // The handler below accepts Ctrl or ⌘; the hint should name the one this
  // keyboard has — "⌘K" means nothing on Windows or Linux.
  const cmdShortcut = typeof navigator !== 'undefined'
    && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl+K';

  function openCmd() { cmdOpen = true; }
  function closeCmd() { cmdOpen = false; }

  // ── Key bindings ──────────────────────────────────────────────────
  // The mapping lives in $lib/hotkeys; the palette and dropdown state stay
  // here, so the context reads and writes them through closures.
  const keyCtx = {
    cmdOpen: () => cmdOpen,
    openCmd,
    closeOverlays: () => { closeCmd(); notifOpen = false; },
    views: () => allViews,
    navigate,
  };
  function handleKeydown(e: KeyboardEvent) {
    handleShellKeydown(e, keyCtx);
  }

  // ── Theme injection ───────────────────────────────────────────────────
  // See $lib/theme. Re-runs whenever the active theme store changes.
  $: if (typeof document !== 'undefined') applyTheme($activeTheme);

  // ── Header badges from store ───────────────────────────────────────
  $: taskOverdue = ($data as any)?.tasks?.overdue?.length ?? 0;
  $: commDrafts = ($data as any)?.comms?.kpis?.drafts ?? 0;

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

  // ── LLM readiness, as information rather than a wall ──────────────
  //
  // `null` = not asked yet or unreachable, which is not evidence of anything
  // and must not paint a warning. Only a verdict that says `ok: false` does.
  let llmVerdict: { ok: boolean; reason?: string; detail?: string } | null = null;
  let llmBannerDismissed = false;
  $: llmMissing = llmVerdict?.ok === false;

  async function refreshLlmReadiness() {
    try {
      const r = await fetch('/api/llm/readiness');
      if (!r.ok) return;
      const v = await r.json();
      if (v && typeof v.ok === 'boolean') llmVerdict = v;
    } catch {
      /* Kernel unreachable — the offline handling covers it. */
    }
  }


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

  // ── Update notice ────────────────────────────────────────────────────
  //
  // State, fetching and the apply POST all live in $lib/update.ts, because the
  // About card in settings shows the same thing and drives the same buttons.
  // Two copies of this would drift the moment either one refreshed: updating
  // from About would leave this strip still announcing the release you just
  // installed. Everything there fails quiet — an update check has no business
  // breaking the shell it renders into.

  onMount(() => {
    initUpdateStore();
    void refreshUpdateInfo();
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
    // Resizing changes whether the tab rail overflows, and the fades are the
    // only cue that it does — without this they stay stale until the next
    // scroll or navigation.
    window.addEventListener('resize', updateRailFades);
    return () => window.removeEventListener('resize', updateRailFades);
  });

  // Leaving /login or /setup without a page load → initialize now. Gated on
  // `mounted` so init never runs before the router is live (it calls goto()).
  $: if (mounted && !isStandalonePage && !shellInitialized) initShell();

  function initShell() {
    if (shellInitialized) return;
    shellInitialized = true;
    // First-run redirect to the setup wizard — fire-and-forget, do NOT
    // early-return (see $lib/shell-init).
    redirectFirstRun(goto);

    // ── Is there an LLM that can run an agent? ──────────────────────
    //
    // Asked up front, but it no longer decides whether you get a dashboard.
    // Chat and agents need a model; tasks, CRM, finance, health, the calendar
    // and every other local-data screen do not, and used to be pushed off the
    // road because a different subsystem had no key. So the verdict drives a
    // banner and the state of two nav entries, not a redirect.
    //
    // Deliberately NOT keyed off localStorage the way the first-run redirect
    // above is: a flag in the browser is not evidence about the server.
    void refreshLlmReadiness();

    // Fetch server timezone before starting clock
    rpcOrCall('server.health', {}, () => fetch('/api/health').then(r => r.json())).then((d: any) => {
      if (d?.timezone) { serverTimezone = d.timezone; serverTz.set(d.timezone); }
      updateClock();
    }).catch(() => {});
    updateClock();
    clockInterval = setInterval(updateClock, 1000);

    // Google OAuth redirect handling
    showGoogleAuthBanner();

    // Drop service workers left over from an old PWA build of the dashboard.
    evictServiceWorkers();

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

    // 3. Rebuild nav groups + items from scratch (hardcoded base + manifest)
    const nav = buildNav(m);

    // 4. Publish extension page bundles for the [...ext] host route.
    extPagesStore.set(Array.isArray(m.extPages) ? m.extPages : []);
    extPagesReady.set(true);

    navGroups = nav.navGroups;
    allViews = nav.allViews;
    viewToGroup = nav.viewToGroup;
    // Rewrite path overrides: start fresh so removed items don't linger.
    for (const k of Object.keys(viewPathOverrides)) delete viewPathOverrides[k];
    for (const k of Object.keys(nav.viewPaths)) viewPathOverrides[k] = nav.viewPaths[k];
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
<!-- The notices sit OUTSIDE .app-shell on purpose. That element is a
     two-column grid (sidebar + content), so a child of it becomes a cell in
     the sidebar column: the banner rendered ~70px wide with one word per line
     and the button spilling out of it. The header escapes this with
     `grid-column: 1 / -1`; a full-width strip that is not part of the app
     chrome is simpler to keep above the grid entirely. -->
<div class="app-root">
  {#if $showUpdateBanner && $updateInfo}
    <div class="update-bar" role="status">
      <span class="update-bar-dot" aria-hidden="true"></span>
      <!-- The message is the flexible cell: it absorbs the free width so the
           actions always end up against the right edge. The alignment used to
           hang off `margin-left:auto` on the "What changed" link, which is
           optional — with no release URL the buttons drifted back into the
           middle of the bar, next to the sentence. -->
      <span class="update-bar-msg">
        Kernl <strong>{$updateInfo.latest}</strong> is available — you are running
        {$updateInfo.current}
      </span>
      {#if $updateInfo.url}
        <a class="update-bar-link" href={$updateInfo.url} target="_blank" rel="noreferrer">
          What changed
        </a>
      {/if}
      <!-- No button where the install cannot replace itself (a container, an
           app running from its disk image): the kernel's instruction instead
           of a click whose only outcome is a refusal. -->
      {#if $canApplyUpdate}
        <!-- The download, the checksum and the unpack all finish before the
             kernel exits, so the bar has something real to show for the part
             of the wait that is actually long. Same store and same rule as
             the About card. Without this the bar said "Updating…" and
             nothing else for the whole download. -->
        <UpdateProgress variant="bar" />
        <button class="update-bar-go" disabled={$updating} on:click={applyUpdate}>
          {$updating ? 'Updating…' : 'Update now'}
        </button>
      {:else if $updateInfo.install?.hint}
        <code title={$updateInfo.install.reason ?? ''}>{$updateInfo.install.hint}</code>
      {/if}
      <button class="update-bar-close" title="Dismiss until the next release" on:click={dismissUpdate}>✕</button>
    </div>
  {/if}

  {#if $updateError}
    <div class="update-bar update-bar-err" role="alert">
      <span class="update-bar-msg">{$updateError}</span>
      {#if $updateHint}<code>{$updateHint}</code>{/if}
      <button class="update-bar-close" on:click={() => updateError.set('')}>✕</button>
    </div>
  {:else if $updateNotice}
    <div class="update-bar" role="status">
      <span class="update-bar-dot" aria-hidden="true"></span>
      <span class="update-bar-msg">{$updateNotice}</span>
      <button class="update-bar-close" on:click={() => updateNotice.set('')}>✕</button>
    </div>
  {/if}

<div class="app-shell">
  <!-- Header -->
  <header class="header">
    <div class="header-logo">
      <img class="header-logo-img" src="/mascot.png" alt="Kernl" />
    </div>

    <!-- Group tabs. They used to occupy a full 37px band across the top of
         the content area while this strip of the header sat empty. Moved
         here they cost no vertical space and sit next to the group name,
         which the rail can only convey through a highlighted icon. -->
    {#if headerTabs.length > 0}
      <div class="header-nav">
        {#if currentGroup}
          <span class="header-nav-group">{groupLabel(currentGroup)}</span>
        {/if}
        <!-- A nav, not a tablist: each of these changes the URL and is
             deep-linkable, so `aria-current="page"` is the honest marker.
             role="tab" would promise a tabpanel swapped in place. -->
        <div class="tabrail" class:fade-l={railFadeL} class:fade-r={railFadeR}>
          <nav
            class="tabrail-track"
            aria-label={currentGroup ? $t('nav.groupViews', { group: groupLabel(currentGroup) }) : $t('nav.views')}
            bind:this={tabRailEl}
            on:scroll={updateRailFades}
          >
            {#each headerTabs as view (view.id)}
              <button
                class="tabrail-tab"
                class:active={currentView === view.id}
                aria-current={currentView === view.id ? 'page' : undefined}
                on:click={() => navigate(view.id)}
              >
                {viewLabel(view)}
              </button>
            {/each}
          </nav>
        </div>
      </div>
    {/if}
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
          on:markAllRead={markAllNotifsRead}
          on:viewAll={() => { notifOpen = false; navigate('notifications'); }}
        />
      </div>

      <!-- Music indicator (only visible while an album is loaded). -->
      <MusicNavIndicator />

      <!-- Action cluster: things the user actively reaches for -->
      <div class="hdr-cluster hdr-actions">
        <button class="search-trigger" on:click={openCmd}>
          <span class="search-icon" aria-hidden="true">⌕</span>
          <span class="search-label">{$t('header.search')}</span>
          <kbd>{cmdShortcut}</kbd>
        </button>
      </div>

      <!-- Meta cluster: connection + theme. Compact, low-attention. -->
      <div class="hdr-cluster hdr-meta">
        <LlmChainPill />
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
          title={groupLabel(group)}
        >
          <span class="nav-icon">{group.icon}</span>
          <span class="nav-label">{groupLabel(group)}</span>
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
        <span class="nav-label">{$t('nav.view.chat')}</span>
      </button>

      <!-- System group pinned at bottom -->
      <button
        class="nav-item"
        class:active={currentGroupId === sysGroup.id}
        on:click={() => navigateGroup(sysGroup)}
        title={groupLabel(sysGroup)}
      >
        <span class="nav-icon">{sysGroup.icon}</span>
        <span class="nav-label">{groupLabel(sysGroup)}</span>
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

  <!-- Main content. Los tabs del grupo viven en el header; la navegación de
       segundo nivel es el rail lateral, que el shell dibuja una sola vez en
       vez de que cada página se pinte la suya. -->
  <main class="main-content" class:full-bleed-mode={isFullBleed}>
    {#if navigating}
      <div style="position:absolute;top:0;left:0;right:0;height:2px;z-index:999;overflow:hidden">
        <div style="height:100%;background:var(--teal,#3dd6c8);animation:pageLoad 0.8s ease-in-out infinite;transform-origin:left"></div>
      </div>
    {/if}

    <!-- What used to be a redirect. Says which features are off and where to
         fix it, and gets out of the way of the ones that still work. -->
    {#if llmMissing && !llmBannerDismissed && !isStandalonePage}
      <div class="llm-banner" role="status">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>
        <span class="llm-banner-text">{$t('llm.banner')}</span>
        <a class="llm-banner-fix" href="/settings?section=ai&card=providers">{$t('llm.banner_fix')} →</a>
        <button class="llm-banner-x" title={$t('llm.banner_dismiss')} aria-label={$t('llm.banner_dismiss')} on:click={() => (llmBannerDismissed = true)}>✕</button>
      </div>
    {/if}
    <div class="content-frame" class:with-rail={railItems.length > 0}>
      {#if railItems.length > 0}
        <SideNav
          items={railItems}
          active={currentView}
          onSelect={navigate}
          ariaLabel={currentGroup ? $t('nav.groupViews', { group: groupLabel(currentGroup) }) : $t('nav.views')}
        />
      {/if}
      <div class="main-inner" class:navigating-fade={navigating}>
        {#if routeGated}
          <ExtensionGate />
        {:else}
          <slot />
        {/if}
      </div>
    </div>
  </main>
</div>
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

<style>
  .llm-banner {
    display: flex; align-items: center; gap: 10px; margin: 0 0 12px; padding: 8px 12px;
    border: 1px solid color-mix(in srgb, var(--orange) 40%, var(--border)); border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--orange) 8%, var(--surface-1)); color: var(--text-1); font-size: 13px;
  }
  .llm-banner svg { color: var(--orange); flex: none; }
  .llm-banner-text { flex: 1; min-width: 0; }
  .llm-banner-fix { color: var(--teal); font-weight: 600; text-decoration: none; white-space: nowrap; }
  .llm-banner-x { border: 0; background: none; color: var(--text-2); cursor: pointer; min-width: 32px; min-height: 32px; }
</style>

