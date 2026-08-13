<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { modelIds } from '$lib/llm-models.js';
  import HostIntegrations from '$lib/components/HostIntegrations.svelte';
  import SkillsHub from '$lib/components/SkillsHub.svelte';

  type ExtensionType =
    | 'module' | 'skill' | 'agent-bundle' | 'office' | 'flow'
    | 'theme' | 'template' | 'channel'
    | 'llm-provider' | 'sandbox-driver' | 'db-driver' | 'suite';
  type ExtensionStatus = 'installed' | 'active' | 'disabled' | 'error';

  interface ExtensionItem {
    id: string;
    slug: string;
    name: string;
    version: string;
    type: ExtensionType;
    status: ExtensionStatus;
    install_path: string;
    installed_at: string;
    updated_at: string;
    last_loaded_at: string | null;
    error: string;
    /** Null for free extensions. Present for paid ones whether licensed or
     *  not, so the card can say which feature a locked row is waiting on. */
    entitlement: { required_feature: string; licensed: boolean } | null;
    manifest: {
      description?: string;
      author?: string;
      license?: string;
      category?: string;
      icon?: string;
      logo?: string;
      tags?: string[];
      dependencies?: string[];
      permissions?: string[];
      pricing?: { amount_cents: number; currency: string; model: string };
      integrity?: { sha256?: string };
      /** Pro-author extensions that want a consent click before anything loads. */
      requires_activation?: boolean;
      /** Compiled into the kernel — the row is a registry stub, not a bundle. */
      built_in?: boolean;
    } | null;
    source: unknown;
    granted_permissions: string[] | null;
    settings: Record<string, unknown> | null;
    /**
     * Signed record of how this extension got here, rendered by the receipt
     * panel below. `{}` when the row predates receipts.
     */
    install_receipt: {
      install_id?: string;
      installed_at?: string;
      bundle_sha256?: string;
      install_sha256?: string;
      kernel_identity?: string;
      signature?: string;
      source?: Record<string, unknown> & { type?: string };
      remote_watermark?: {
        download_id: string;
        source_fp: string;
        downloader_fp: string;
        ts: string;
        signature: string;
      } | null;
    } | null;
  }

  interface StatsBlock {
    total: number;
    by_status: Record<string, number>;
    by_type: Record<string, number>;
  }

  const BASE = (globalThis as { __API_BASE?: string }).__API_BASE ?? '';

  let items: ExtensionItem[] = [];
  let stats: StatsBlock | null = null;
  let loading = true;
  let loadError = '';

  let search = '';
  let filterType: ExtensionType | '' = '';
  let filterStatus: ExtensionStatus | '' = '';

  let selected: ExtensionItem | null = null;

  let showUpload = false;
  let uploadFile: File | null = null;
  let uploadPath = '';
  let uploading = false;
  let uploadError = '';

  // ── Subscribed catalog repos (path C) ──
  interface CatalogRepoRow {
    id: string;
    url: string;
    ref: string;
    name: string;
    description: string;
    items_found: number;
    sync_error: string;
    last_synced_at: string | null;
    added_at: string;
  }

  let repos: CatalogRepoRow[] = [];
  let reposLoaded = false;
  let showAddRepo = false;
  let newRepoUrl = '';
  let newRepoRef = '';
  let newRepoName = '';
  let addingRepo = false;
  let repoError = '';
  let busyRepoId: string | null = null;

  const TYPE_META_DEFAULT = { icon: '◇', label: 'Other', tint: 'var(--text-3)' };
  const TYPE_META: Record<ExtensionType, { icon: string; label: string; tint: string }> = {
    'module':         { icon: '◆',  label: 'Module',   tint: 'var(--ext-module)' },
    'skill':          { icon: '✦',  label: 'Skill',    tint: 'var(--ext-skill)' },
    'agent-bundle':   { icon: '◉',  label: 'Agent',    tint: 'var(--ext-agent)' },
    'office':         { icon: '🏢', label: 'Office',   tint: 'var(--ext-agent)' },
    'flow':           { icon: '⬡',  label: 'Flow',     tint: 'var(--ext-flow)' },
    'theme':          { icon: '◐',  label: 'Theme',    tint: 'var(--ext-theme)' },
    'template':       { icon: '▤',  label: 'Template', tint: 'var(--ext-template)' },
    'channel':        { icon: '◎',  label: 'Channel',  tint: 'var(--ext-channel)' },
    'llm-provider':   { icon: '🧠', label: 'LLM',      tint: 'var(--ext-module)' },
    'sandbox-driver': { icon: '⬢',  label: 'Sandbox',  tint: 'var(--ext-module)' },
    'db-driver':      { icon: '▦',  label: 'Database', tint: 'var(--ext-module)' },
    'suite':          { icon: '⊞',  label: 'Suite',    tint: 'var(--ext-template)' },
  };
  const metaOf = (t: string) =>
    TYPE_META[t as ExtensionType] ?? TYPE_META_DEFAULT;

  /**
   * Resolve a manifest.logo value to a URL the browser can fetch.
   * - Absolute URLs (http:// or https://) → used verbatim
   * - Paths starting with `/` → treated as kernel-hosted (e.g. /api/extensions/brand/…)
   * - Bare filenames → resolved via the per-extension API (bundle-dir relative)
   */
  function logoUrl(ext: { id: string; manifest: { logo?: string } | null }): string | null {
    const logo = ext.manifest?.logo;
    if (!logo) return null;
    if (/^https?:\/\//i.test(logo) || logo.startsWith('/')) {
      return logo.startsWith('/') ? `${BASE}${logo}` : logo;
    }
    return `${BASE}/api/extensions/item/${encodeURIComponent(ext.id)}/logo`;
  }

  /** Resolve a dependency reference (id or slug) to the matching extension, if installed. */
  function resolveDep(ref: string): ExtensionItem | null {
    return items.find((x) => x.id === ref || x.slug === ref) ?? null;
  }

  /** Return the extensions that declare `ext` (by id or slug) in their dependencies[]. */
  function findDependents(ext: ExtensionItem): ExtensionItem[] {
    return items.filter((other) => {
      if (other.id === ext.id) return false;
      const deps = other.manifest?.dependencies ?? [];
      return deps.includes(ext.id) || deps.includes(ext.slug);
    });
  }

  const TYPE_ORDER: ExtensionType[] =
    ['module', 'skill', 'office', 'agent-bundle', 'flow', 'theme', 'template', 'channel',
     'llm-provider', 'sandbox-driver', 'db-driver', 'suite'];

  const STATUS_ORDER: ExtensionStatus[] =
    ['active', 'installed', 'disabled', 'error'];

  const STATUS_META: Record<ExtensionStatus, { label: string; tint: string }> = {
    'active':    { label: 'ACTIVE',    tint: 'var(--green)' },
    'installed': { label: 'INSTALLED', tint: 'var(--gold)' },
    'disabled':  { label: 'DISABLED',  tint: 'var(--text-3)' },
    'error':     { label: 'ERROR',     tint: 'var(--red)' },
  };

  // ══════════════════════════════════════════════════════════════════════
  //  Marketplace: browse, buy, install
  // ══════════════════════════════════════════════════════════════════════
  //
  // Two data sources, one per tab, because they answer different questions:
  //
  //   • /api/marketplace/catalog — everything installable: the in-tree bundles,
  //     items from subscribed git repos, and the paid store shelf. Drives
  //     Discover + Updates.
  //   • /api/extensions          — the installed rows, with receipts, settings
  //     and per-type admin panels. Drives Installed and every drawer below.
  //
  // Searching in a tab searches what that tab shows, which is the whole point:
  // the old page only ever searched the installed rows, so searching for
  // something you hadn't installed yet always came back empty.

  // 'skills' is not a slice of the same list as the others: it swaps the grid
  // for the skills hub, which is organised by agent assignment rather than by
  // install state. It lives here anyway because a skill IS an extension, and
  // splitting it back out into its own page is exactly what we just undid.
  type Tab = 'discover' | 'installed' | 'updates' | 'skills';
  type PriceFilter = '' | 'free' | 'paid';
  type CardStatus =
    | 'available' | 'for_sale' | 'owned'
    | 'installed' | 'active' | 'disabled' | 'error';

  interface CatalogEntry {
    id: string;
    slug: string;
    origin: { provider: string; source?: unknown };
    manifest: {
      name: string;
      version: string;
      type: ExtensionType;
      description?: string;
      author?: string;
      icon?: string;
      logo?: string;
      category?: string;
      tags?: string[];
      license?: string;
      permissions?: string[];
      pricing?: { amount_cents: number; currency: string; model: string };
    };
    status: CardStatus;
    installed_id?: string;
    installed_version?: string;
    update_available?: boolean;
    price_cents: number;
    currency: string;
    price_id?: string | null;
    feature?: string;
  }

  /** Normalized shape the card grid renders, whichever source it came from. */
  interface CardVM {
    key: string;
    slug: string;
    name: string;
    version: string;
    type: ExtensionType;
    icon: string;
    logo: string | null;
    description: string;
    author: string;
    status: CardStatus;
    priceCents: number;
    currency: string;
    /** Stripe price id. Null → not purchasable in-app (see actionFor). */
    priceId: string | null;
    updateAvailable: boolean;
    installedVersion: string;
    /** The rich installed row, when this thing is installed. */
    installed: ExtensionItem | null;
    /** The catalog entry, when it came from the catalog. */
    catalog: CatalogEntry | null;
    error: string;
    provider: string;
  }

  let tab: Tab = 'discover';
  let priceFilter: PriceFilter = '';
  let typeMenuOpen = false;

  let catalogItems: CatalogEntry[] = [];
  let catalogLoading = false;
  let catalogError = '';

  let storeReachable = true;
  let storeError = '';
  // The license is not tracked here on purpose: the catalog already resolves
  // it into per-item `owned` / `for_sale` statuses server-side, so a second
  // client-side copy could only ever disagree with it.

  interface AllAccessPrice {
    price_id: string;
    price_cents: number | null;
    currency: string;
    interval: string | null;
  }
  let allAccess: { monthly: AllAccessPrice | null; yearly: AllAccessPrice | null } | null = null;
  let showRepos = false;
  let showPlusMenu = false;

  /** In-flight and finished purchases, keyed by slug. */
  interface PurchaseState {
    sessionId: string;
    state: 'pending' | 'paid' | 'done' | 'failed';
    error: string | null;
    url: string;
  }
  let purchases: Record<string, PurchaseState> = {};
  const pollTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Slugs with an install request in flight (free or entitled). */
  let installing: Record<string, boolean> = {};

  // ── Catalog ──────────────────────────────────────────────────────────

  /** Set once per page load so the first fetch bypasses the provider cache. */
  let catalogNeedsRefresh = true;

  async function fetchCatalog(): Promise<void> {
    catalogLoading = true;
    catalogError = '';
    const params = new URLSearchParams();
    if (filterType) params.set('type', filterType);
    if (search) params.set('q', search);
    // A reload must never show yesterday's prices; typing in the search box
    // should not re-hit the store on every keystroke.
    if (catalogNeedsRefresh) {
      params.set('refresh', '1');
      catalogNeedsRefresh = false;
    }
    try {
      const r = await fetch(`${BASE}/api/marketplace/catalog?${params}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      catalogItems = body.items ?? [];
    } catch (e) {
      catalogError = (e as Error).message;
      catalogItems = [];
    } finally {
      catalogLoading = false;
    }
  }

  /** Store reachability + license state + purchases to resume after a reload. */
  async function fetchStoreStatus(): Promise<void> {
    try {
      // no-store, always: this drives prices and the Buy affordance. A cached
      // response here means showing yesterday's offer — or hiding today's.
      const r = await fetch(`${BASE}/api/store/status`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      storeReachable = body.reachable !== false;
      storeError = body.error ?? '';
      allAccess = body.all_access ?? null;
      for (const row of body.open_checkouts ?? []) {
        purchases[row.slug] = {
          sessionId: row.session_id,
          state: row.state,
          error: row.error ?? null,
          url: row.checkout_url ?? '',
        };
        pollCheckout(row.session_id, row.slug);
      }
      purchases = { ...purchases };
    } catch {
      // The store being unreachable is not a page error — the local catalog
      // still works. We only note it so paid cards can explain themselves.
      storeReachable = false;
    }
  }

  // ── Buying ───────────────────────────────────────────────────────────

  /**
   * Open a Stripe Checkout for `slug` in a new tab and start polling. The
   * kernel holds the session id, applies the minted license and installs the
   * bundle — the user never touches a license key.
   */
  async function buy(slug: string): Promise<void> {
    try {
      const r = await fetch(`${BASE}/api/store/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409 && body.already_owned) {
        // License already covers it — install instead of charging again.
        await installFromStore(slug);
        return;
      }
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);

      purchases[slug] = { sessionId: body.session_id, state: 'pending', error: null, url: body.url };
      purchases = { ...purchases };
      window.open(body.url, '_blank', 'noopener');
      pollCheckout(body.session_id, slug);
    } catch (e) {
      purchases[slug] = {
        sessionId: '',
        state: 'failed',
        error: (e as Error).message,
        url: '',
      };
      purchases = { ...purchases };
    }
  }

  /**
   * Poll a checkout until it resolves. 2.5s is a good cadence: the webhook
   * usually lands within a second or two of payment, and the user is looking at
   * another tab anyway.
   */
  function pollCheckout(sessionId: string, slug: string): void {
    const tick = async (): Promise<void> => {
      try {
        // A cached poll response would freeze the purchase mid-flight and the
        // card would never leave "Waiting for payment…".
        const r = await fetch(`${BASE}/api/store/checkout/${encodeURIComponent(sessionId)}`, {
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        purchases[slug] = {
          sessionId,
          state: body.state,
          error: body.error ?? null,
          url: body.url ?? '',
        };
        purchases = { ...purchases };

        if (body.state === 'done') {
          await Promise.all([fetchList(), fetchCatalog()]);
          window.dispatchEvent(new CustomEvent('manifest:refresh'));
          return;
        }
        if (body.state === 'failed') {
          // The license may still have been applied — refresh so an "owned"
          // card shows up even when the install leg failed.
          await Promise.all([fetchList(), fetchCatalog()]);
          return;
        }
      } catch {
        // Transient — keep polling. The server-side claim window is what
        // actually ends this.
      }
      const t = setTimeout(() => { pollTimers.delete(t); void tick(); }, 2500);
      pollTimers.add(t);
    };
    void tick();
  }

  /** Install a paid item the license already covers. */
  async function installFromStore(slug: string): Promise<void> {
    installing[slug] = true;
    installing = { ...installing };
    try {
      const r = await fetch(`${BASE}/api/store/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      await Promise.all([fetchList(), fetchCatalog()]);
      window.dispatchEvent(new CustomEvent('manifest:refresh'));
    } catch (e) {
      alert(`Install failed: ${(e as Error).message}`);
    } finally {
      installing[slug] = false;
      installing = { ...installing };
    }
  }

  /** Install a free catalog item (bundled, or from a subscribed git repo). */
  async function installFromCatalog(entry: CatalogEntry): Promise<void> {
    installing[entry.slug] = true;
    installing = { ...installing };
    try {
      const r = await fetch(`${BASE}/api/marketplace/catalog/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entry.id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      await Promise.all([fetchList(), fetchCatalog()]);
      window.dispatchEvent(new CustomEvent('manifest:refresh'));
    } catch (e) {
      alert(`Install failed: ${(e as Error).message}`);
    } finally {
      installing[entry.slug] = false;
      installing = { ...installing };
    }
  }

  /** One entry point for "get this thing", whatever kind of thing it is. */
  async function acquire(vm: CardVM): Promise<void> {
    if (vm.status === 'for_sale') return buy(vm.slug);
    if (vm.status === 'owned') return installFromStore(vm.slug);
    if (vm.catalog) return installFromCatalog(vm.catalog);
  }

  // ── View models ──────────────────────────────────────────────────────

  function catalogToVM(e: CatalogEntry): CardVM {
    return {
      key: e.id,
      slug: e.slug,
      name: e.manifest.name,
      version: e.manifest.version,
      type: e.manifest.type,
      icon: e.manifest.icon ?? metaOf(e.manifest.type).icon,
      logo: e.manifest.logo ?? null,
      description: e.manifest.description ?? '',
      author: e.manifest.author ?? '',
      status: e.status,
      priceCents: e.price_cents ?? 0,
      currency: e.currency ?? 'USD',
      priceId: e.price_id ?? null,
      updateAvailable: e.update_available ?? false,
      installedVersion: e.installed_version ?? '',
      installed: e.installed_id ? items.find((i) => i.id === e.installed_id) ?? null : null,
      catalog: e,
      error: '',
      provider: e.origin?.provider ?? '',
    };
  }

  function installedToVM(x: ExtensionItem): CardVM {
    return {
      key: x.id,
      slug: x.slug,
      name: x.name,
      version: x.version,
      type: x.type,
      icon: x.manifest?.icon ?? metaOf(x.type).icon,
      logo: x.manifest?.logo ?? null,
      description: x.manifest?.description ?? '',
      author: x.manifest?.author ?? '',
      status: x.status,
      priceCents: x.manifest?.pricing?.amount_cents ?? 0,
      currency: x.manifest?.pricing?.currency ?? 'USD',
      priceId: null,
      updateAvailable: false,
      installedVersion: x.version,
      installed: x,
      catalog: null,
      error: x.error,
      provider: 'installed',
    };
  }

  const isInstalledStatus = (s: CardStatus): boolean =>
    s === 'installed' || s === 'active' || s === 'disabled' || s === 'error';

  function matchesPrice(vm: CardVM): boolean {
    if (priceFilter === 'free') return vm.priceCents === 0;
    if (priceFilter === 'paid') return vm.priceCents > 0;
    return true;
  }

  /** Client-side text match for the Installed tab (the catalog filters server-side). */
  function matchesSearch(vm: CardVM): boolean {
    if (!search) return true;
    const q = search.toLowerCase();
    return [vm.name, vm.slug, vm.description, vm.author].join(' ').toLowerCase().includes(q);
  }

  /**
   * Discover is a storefront, so it shows only things you can still get:
   * anything already installed is noise there and lives in the Installed tab.
   * Without this, 85 of the 106 catalog entries were extensions the user had
   * already installed, burying the ~20 they could actually acquire.
   */
  $: cards =
    tab === 'installed'
      ? items
          .map(installedToVM)
          .filter((vm) => (!filterStatus || vm.status === filterStatus) && matchesPrice(vm) && matchesSearch(vm))
      : tab === 'updates'
        ? catalogItems.filter((e) => e.update_available).map(catalogToVM).filter(matchesPrice)
        : catalogItems
            .map(catalogToVM)
            .filter((vm) => !isInstalledStatus(vm.status))
            .filter(matchesPrice);

  /** The paid shelf — the storefront rail. Owned-but-uninstalled leads it. */
  $: shelfCards = tab === 'discover'
    ? cards
        .filter((vm) => vm.status === 'for_sale' || vm.status === 'owned')
        .sort((a, b) => (a.status === 'owned' ? -1 : b.status === 'owned' ? 1 : b.priceCents - a.priceCents))
    : [];

  /** Everything free and not yet installed. */
  $: freeCards = tab === 'discover' ? cards.filter((vm) => vm.status === 'available') : [];

  /**
   * How many paid items the license still doesn't cover. This — not "does a
   * license exist" — is what decides whether All-Access is worth offering:
   * someone who bought a single extension still has the whole rest of the
   * shelf to unlock, and `isPro` is true for any valid license. When a real
   * All-Access license is present every item reports `owned`, so this hits
   * zero and the offer disappears on its own.
   */
  $: forSaleCount = shelfCards.filter((vm) => vm.status === 'for_sale').length;
  /** Paid items the license already covers — changes the All-Access pitch. */
  $: ownedCount = shelfCards.filter((vm) => vm.status === 'owned').length;

  /** How many installed items Discover is deliberately not showing. */
  $: hiddenInstalled = catalogItems.filter((e) => isInstalledStatus(e.status as CardStatus)).length;

  /**
   * What the compact grid renders. In Discover the paid items are pulled out
   * into the storefront rail above, so the grid holds only the free shelf —
   * which keeps one card implementation for every tab.
   */
  $: gridCards = tab === 'discover' ? freeCards : cards;

  /** Split a formatted price into currency symbol and digits for the big numeral. */
  function priceParts(cents: number, currency: string): { sym: string; num: string } {
    const formatted = fmtMoney(cents, currency);
    const m = /^([^\d]*)(.*)$/.exec(formatted);
    return { sym: (m?.[1] ?? '').trim(), num: m?.[2] ?? formatted };
  }

  /** Type counts for the type menu — only types that actually have something. */
  $: typeCounts = (() => {
    const src =
      tab === 'installed'
        ? items.map(installedToVM)
        : catalogItems.map(catalogToVM).filter((vm) => !isInstalledStatus(vm.status));
    const out: Partial<Record<ExtensionType, number>> = {};
    for (const vm of src) out[vm.type] = (out[vm.type] ?? 0) + 1;
    return out;
  })();

  $: installedCount = items.length;
  $: skillCount = items.filter((i) => i.type === 'skill').length;
  $: updatesCount = catalogItems.filter((e) => e.update_available).length;
  $: errorCount = items.filter((i) => i.status === 'error').length;
  /** Counts what Discover actually shows — not the whole catalog. */
  $: discoverCount = catalogItems.filter((e) => !isInstalledStatus(e.status as CardStatus)).length;

  /** What the card's primary button says and does. */
  function actionFor(vm: CardVM): {
    label: string;
    disabled: boolean;
    kind: 'buy' | 'get' | 'update' | 'manage' | 'pricing';
  } {
    const purchase = purchases[vm.slug];
    if (purchase && (purchase.state === 'pending' || purchase.state === 'paid')) {
      return {
        label: purchase.state === 'paid' ? 'Installing…' : 'Waiting for payment…',
        disabled: true,
        kind: 'buy',
      };
    }
    if (installing[vm.slug]) return { label: 'Installing…', disabled: true, kind: 'get' };
    if (vm.updateAvailable) return { label: `Update to v${vm.version}`, disabled: false, kind: 'update' };
    if (vm.status === 'for_sale') {
      // No resolvable price — an older store, an unpublished item, or Stripe
      // being down. Send the user to the pricing page rather than showing a Buy
      // button that can't charge, or worse, labelling a paid item "Free".
      if (!vm.priceId || vm.priceCents <= 0) {
        return { label: 'See pricing', disabled: false, kind: 'pricing' };
      }
      return { label: `${fmtMoney(vm.priceCents, vm.currency)} · Buy`, disabled: !storeReachable, kind: 'buy' };
    }
    if (vm.status === 'owned') return { label: 'Install', disabled: false, kind: 'get' };
    if (vm.status === 'available') return { label: 'Install', disabled: false, kind: 'get' };
    return { label: 'Manage', disabled: false, kind: 'manage' };
  }

  const PRICING_URL = 'https://lifekernl.com/pricing';

  /** Route a card button press to the right thing. */
  function onCardAction(vm: CardVM, kind: ReturnType<typeof actionFor>['kind']): void {
    if (kind === 'manage') return openCard(vm);
    if (kind === 'pricing') {
      window.open(PRICING_URL, '_blank', 'noopener');
      return;
    }
    void acquire(vm);
  }

  /** The price chip on a card. Paid-but-unpriced must never read as "Free". */
  function priceBadge(vm: CardVM): string {
    if (vm.status === 'owned') return '✓ Owned';
    if (vm.priceCents > 0) return fmtMoney(vm.priceCents, vm.currency);
    return 'PAID';
  }

  function fmtMoney(cents: number, currency: string): string {
    if (!cents) return 'Free';
    const amount = cents / 100;
    const whole = Number.isInteger(amount);
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'USD',
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      }).format(amount);
    } catch {
      return `${currency} ${whole ? amount.toFixed(0) : amount.toFixed(2)}`;
    }
  }

  /** Open a card: installed things get the full drawer, catalog things a preview. */
  let previewed: CardVM | null = null;
  function openCard(vm: CardVM): void {
    if (vm.installed) {
      selected = vm.installed;
      previewed = null;
    } else {
      previewed = vm;
    }
  }

  const STATUS_LABEL: Record<CardStatus, string> = {
    available: 'NOT INSTALLED',
    for_sale:  'PAID',
    owned:     'OWNED',
    installed: 'INSTALLED',
    active:    'ACTIVE',
    disabled:  'DISABLED',
    error:     'ERROR',
  };

  // ── Catalog repos (path C — git-discovered skills) ──

  async function fetchRepos(): Promise<void> {
    try {
      const r = await fetch(`${BASE}/api/marketplace/repos`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      repos = body.repos ?? [];
      reposLoaded = true;
    } catch (e) {
      repoError = (e as Error).message;
    }
  }

  async function addRepo(): Promise<void> {
    if (!newRepoUrl.trim()) return;
    addingRepo = true;
    repoError = '';
    try {
      const r = await fetch(`${BASE}/api/marketplace/repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: newRepoUrl.trim(),
          ref: newRepoRef.trim() || undefined,
          name: newRepoName.trim() || undefined,
        }),
      });
      const body = await r.json();
      if (!r.ok || !body.success) throw new Error(body.error ?? `HTTP ${r.status}`);
      newRepoUrl = '';
      newRepoRef = '';
      newRepoName = '';
      showAddRepo = false;
      await fetchRepos();
      await fetchList();
    } catch (e) {
      repoError = (e as Error).message;
    } finally {
      addingRepo = false;
    }
  }

  async function syncRepo(id: string): Promise<void> {
    busyRepoId = id;
    try {
      const r = await fetch(`${BASE}/api/marketplace/repos/${id}/sync`, { method: 'POST' });
      const body = await r.json();
      if (!body.success) throw new Error(body.result?.error ?? body.error ?? 'sync failed');
      await fetchRepos();
      await fetchList();
    } catch (e) {
      alert(`Sync failed: ${(e as Error).message}`);
    } finally {
      busyRepoId = null;
    }
  }

  async function installAllFromRepo(repo: CatalogRepoRow): Promise<void> {
    if (!confirm(
      `Install ALL skills from "${repo.name}"?\n\n` +
      `This will install every discovered item from ${repo.url} into your kernel. ` +
      `Items already installed will be skipped.\n\nProceed?`,
    )) return;
    busyRepoId = repo.id;
    try {
      const r = await fetch(`${BASE}/api/marketplace/repos/${repo.id}/install-all`, { method: 'POST' });
      const body = await r.json();
      if (!body.success) throw new Error(body.error ?? 'install-all failed');
      alert(
        `Done!\n  Installed: ${body.installed}\n  Skipped (already installed): ${body.skipped}\n  Errored: ${body.errored}`,
      );
      await fetchList();
    } catch (e) {
      alert(`Install-all failed: ${(e as Error).message}`);
    } finally {
      busyRepoId = null;
    }
  }

  async function removeRepo(id: string, name: string): Promise<void> {
    if (!confirm(`Unsubscribe from "${name}"?\n\nThe local cache will be deleted. ` +
                 `Items already installed from this repo stay installed (their receipts persist).`)) return;
    busyRepoId = id;
    try {
      const r = await fetch(`${BASE}/api/marketplace/repos/${id}`, { method: 'DELETE' });
      const body = await r.json();
      if (!body.success) throw new Error(body.error ?? 'remove failed');
      await fetchRepos();
      await fetchList();
    } catch (e) {
      alert(`Remove failed: ${(e as Error).message}`);
    } finally {
      busyRepoId = null;
    }
  }

  function fmtRelative(isoTs: string | null): string {
    if (!isoTs) return 'never';
    const ms = Date.now() - new Date(isoTs).getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
    return `${Math.floor(ms / 86400_000)}d ago`;
  }

  async function fetchList(): Promise<void> {
    loading = true;
    loadError = '';
    const params = new URLSearchParams();
    if (filterType)   params.set('type', filterType);
    if (filterStatus) params.set('status', filterStatus);
    if (search)       params.set('q', search);
    try {
      const r = await fetch(`${BASE}/api/extensions?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      items = body.items ?? [];
      stats = body.stats ?? null;
    } catch (e) {
      loadError = (e as Error).message;
      items = [];
      stats = null;
    } finally {
      loading = false;
    }
  }

  async function doEnable(id: string): Promise<void> {
    await actionOn(id, `/api/extensions/item/${encodeURIComponent(id)}/enable`);
  }
  async function doDisable(id: string): Promise<void> {
    await actionOn(id, `/api/extensions/item/${encodeURIComponent(id)}/disable`);
  }
  async function doUninstall(id: string, name: string): Promise<void> {
    if (!confirm(`Uninstall "${name}"? This deletes the extension files and row.`)) return;
    await actionOn(id, `/api/extensions/item/${encodeURIComponent(id)}/uninstall`);
    if (selected?.id === id) selected = null;
  }

  /** Activate a `requires_activation` extension. Goes through the same enable
   *  endpoint but shows a consent dialog first so the click is auditable. */
  async function doActivate(ext: any): Promise<void> {
    const ok = confirm(
      `Activate "${ext.name}"?\n\n` +
      `This is a Pro-author extension. By activating you confirm you're ` +
      `authorised to use it (license, contributor, gift, etc.).\n\n` +
      `The activation event is recorded in the install receipt.`,
    );
    if (!ok) return;
    await doEnable(ext.id);
  }

  /** Copy text to clipboard with a tiny visual ack via window.prompt fallback. */
  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older browsers / iframes — fall back to a prompt the user can copy from.
      window.prompt('Copy:', text);
    }
  }

  /** Trigger a JSON file download. Used to export the install receipt so users
   *  can archive it or share it for forensic purposes. */
  function downloadJson(filename: string, payload: unknown): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function actionOn(id: string, url: string): Promise<void> {
    try {
      const r = await fetch(`${BASE}${url}`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      await fetchList();
      if (selected?.id === id) selected = items.find((i) => i.id === id) ?? null;
      // Tell the layout to re-fetch /api/manifest so sidebar updates
      // immediately — enabled/disabled nav items appear/disappear without
      // a page reload.
      window.dispatchEvent(new CustomEvent('manifest:refresh'));
    } catch (e) {
      alert(`Action failed: ${(e as Error).message}`);
    }
  }

  async function doUpload(): Promise<void> {
    uploadError = '';
    if (!uploadFile && !uploadPath) {
      uploadError = 'Pick a .kernl file or paste a server path.';
      return;
    }
    uploading = true;
    try {
      if (uploadFile) {
        const base64 = await fileToBase64(uploadFile);
        const r = await fetch(`${BASE}/api/extensions/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: uploadFile.name, base64 }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
      } else {
        const r = await fetch(`${BASE}/api/extensions/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundle_path: uploadPath }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
      }
      showUpload = false;
      uploadFile = null;
      uploadPath = '';
      await fetchList();
    } catch (e) {
      uploadError = (e as Error).message;
    } finally {
      uploading = false;
    }
  }

  function fileToBase64(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const v = r.result as string;
        resolve(v.substring(v.indexOf(',') + 1));
      };
      r.onerror = () => reject(new Error('Failed to read file'));
      r.readAsDataURL(f);
    });
  }

  function onFilePick(e: Event): void {
    const inp = e.target as HTMLInputElement;
    uploadFile = inp.files && inp.files.length ? inp.files[0] : null;
  }

  function fmtPrice(m: ExtensionItem['manifest']): string {
    if (!m?.pricing || m.pricing.model === 'free') return 'FREE';
    const amount = (m.pricing.amount_cents / 100).toFixed(0);
    const suffix = m.pricing.model === 'subscription' ? '/mo' : '';
    return `${m.pricing.currency} ${amount}${suffix}`;
  }

  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  function onSearchInput(): void {
    if (debounceHandle) clearTimeout(debounceHandle);
    // The catalog filters server-side (it spans providers); the installed list
    // filters client-side off `items`, so it only needs a re-fetch when the
    // type/status query params change.
    debounceHandle = setTimeout(() => { void refetchActive(); }, 200);
  }

  /** Re-query whatever backs the current tab. */
  async function refetchActive(): Promise<void> {
    // The skills hub owns its own fetches (it needs agents too) — re-querying
    // the catalog underneath it would only burn a store round-trip.
    if (tab === 'skills') return;
    if (tab === 'installed') await fetchList();
    else await fetchCatalog();
  }

  function switchTab(next: Tab): void {
    tab = next;
    typeMenuOpen = false;
    // Status only means something for installed things; drop it on the way out
    // so Discover doesn't silently hide everything.
    if (next !== 'installed') filterStatus = '';
    void refetchActive();
  }

  // ── Skills hub wiring ────────────────────────────────────────────────
  // The hub manages assignment; acquisition stays on the paths that already
  // exist, so it delegates those two actions back up here.

  /** "Browse catalog" from the hub → Discover, pre-filtered to skills. */
  function skillsToDiscover(): void {
    filterType = 'skill';
    switchTab('discover');
  }

  /** Open the standard extension drawer for a skill row. */
  function openSkillDetail(slug: string): void {
    const row = items.find((i) => i.slug === slug);
    if (row) selected = row;
    else switchTab('installed');
  }

  function setType(t: ExtensionType | ''): void {
    filterType = t;
    typeMenuOpen = false;
    void refetchActive();
  }

  function clearFilters(): void {
    search = '';
    filterType = '';
    filterStatus = '';
    priceFilter = '';
    void refetchActive();
  }

  $: filtersActive = !!(search || filterType || filterStatus || priceFilter);

  // ── WhatsApp panel ─────────────────────────────────────────────────
  // Beyond the pairing QR, this drawer also surfaces:
  //   • the provider config (allowedNumbers, defaultChat) — editable
  //   • the list of pending pairing codes from unknown contacts
  //   • the list of already-approved senders, with a revoke button
  //   • a test-send form to verify outbound from the dashboard
  interface WhatsAppStatus {
    qr: string | null;
    connected: boolean;
    error: string | null;
  }
  interface PendingPair {
    code: string;
    platform: string;
    userId: string;
    chatId?: string;
    createdAt: string;
    expiresAt: string;
  }
  interface ApprovedPair { platform: string; userId: string; }

  let whatsappStatus: WhatsAppStatus | null = null;
  let whatsappQrDataUrl: string | null = null;
  let whatsappPollHandle: ReturnType<typeof setInterval> | null = null;
  let whatsappRequesting = false;

  let waAllowedNumbers = '';
  let waDefaultChat = '';
  let waConfigSaving = false;
  let waConfigMessage = '';

  let waPending: PendingPair[] = [];
  let waApproved: ApprovedPair[] = [];

  // ── LLM provider config (schema-driven form for type='llm-provider') ──
  interface ConfigField {
    key: string;
    label: string;
    type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea';
    required: boolean;
    placeholder?: string;
    description?: string;
    options?: Array<{ value: string; label: string }>;
    default?: string | number | boolean;
  }
  let llmSchema: ConfigField[] = [];
  let llmConfig: Record<string, unknown> = {};
  let llmModels: string[] = [];
  let llmLoadingModels = false;
  let llmSaving = false;
  let llmMessage = '';
  let llmModelMode: 'list' | 'custom' = 'list';

  async function loadLlmProvider(slug: string): Promise<void> {
    llmSchema = [];
    llmConfig = {};
    llmModels = [];
    llmMessage = '';
    llmModelMode = 'list';
    try {
      const [schemaRes, configRes] = await Promise.all([
        fetch(`${BASE}/api/llm-providers/${encodeURIComponent(slug)}/schema`),
        fetch(`${BASE}/api/llm-providers/${encodeURIComponent(slug)}/config`),
      ]);
      if (schemaRes.ok) llmSchema = ((await schemaRes.json()).schema ?? []) as ConfigField[];
      if (configRes.ok) llmConfig = ((await configRes.json()).config ?? {}) as Record<string, unknown>;
      // If saved model isn't in the discovered list, surface a custom-text input.
      llmLoadingModels = true;
      try {
        const r = await fetch(`${BASE}/api/llm-providers/${encodeURIComponent(slug)}/models`);
        if (r.ok) {
          const body = await r.json();
          llmModels = modelIds(body.models);
        }
      } catch { /* ignore */ }
      llmLoadingModels = false;
      const current = String(llmConfig.defaultModel ?? '');
      if (current && llmModels.length > 0 && !llmModels.includes(current)) {
        llmModelMode = 'custom';
      }
    } catch (err) {
      llmMessage = `Load failed: ${(err as Error).message}`;
    }
  }

  async function saveLlmProvider(slug: string): Promise<void> {
    llmSaving = true;
    llmMessage = '';
    try {
      // Strip empty password fields so an unchanged secret isn't blanked out.
      const payload: Record<string, unknown> = {};
      for (const field of llmSchema) {
        const v = llmConfig[field.key];
        if (field.type === 'password' && (v === '' || v == null)) continue;
        payload[field.key] = v;
      }
      const r = await fetch(`${BASE}/api/llm-providers/${encodeURIComponent(slug)}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: payload }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      llmMessage = body.error ? `Saved (start failed: ${body.error})` : '✓ Saved & reloaded';
      // Refresh card status (ready flag, lastModel, etc.)
      await fetchList();
      if (selected) selected = items.find((i) => i.id === selected!.id) ?? selected;
    } catch (err) {
      llmMessage = `Failed: ${(err as Error).message}`;
    } finally {
      llmSaving = false;
      setTimeout(() => (llmMessage = ''), 4000);
    }
  }

  function setLlmBool(key: string, ev: Event): void {
    llmConfig[key] = (ev.currentTarget as HTMLInputElement).checked;
    llmConfig = llmConfig;
  }

  async function refreshLlmModels(slug: string): Promise<void> {
    llmLoadingModels = true;
    try {
      const r = await fetch(`${BASE}/api/llm-providers/${encodeURIComponent(slug)}/models`);
      if (r.ok) llmModels = modelIds((await r.json()).models);
    } catch { /* ignore */ }
    llmLoadingModels = false;
  }

  // Trigger load whenever the user opens an llm-provider drawer (once per slug).
  let llmLoadedFor = '';
  $: if (selected && selected.type === 'llm-provider' && llmLoadedFor !== selected.slug) {
    llmLoadedFor = selected.slug;
    void loadLlmProvider(selected.slug);
  } else if (!selected) {
    llmLoadedFor = '';
  }

  // ── db-driver config + activation ────────────────────────────────
  // Mirrors the llm-provider pattern. The "Activate" button enforces the
  // single-active-per-kind invariant via /api/db-drivers/:slug/activate;
  // the kernel auto-reverts to the previous driver on start failure.
  let dbSchema: ConfigField[] = [];
  let dbConfig: Record<string, unknown> = {};
  let dbStatus: { active: boolean; ready: boolean; error?: string; capabilities?: Record<string, boolean> } | null = null;
  let dbSaving = false;
  let dbActivating = false;
  let dbMessage = '';

  async function loadDbDriver(slug: string): Promise<void> {
    dbSchema = [];
    dbConfig = {};
    dbStatus = null;
    dbMessage = '';
    try {
      const [schemaRes, configRes, statusRes] = await Promise.all([
        fetch(`${BASE}/api/db-drivers/${encodeURIComponent(slug)}/schema`),
        fetch(`${BASE}/api/db-drivers/${encodeURIComponent(slug)}/config`),
        fetch(`${BASE}/api/db-drivers/${encodeURIComponent(slug)}`),
      ]);
      if (schemaRes.ok) dbSchema = ((await schemaRes.json()).schema ?? []) as ConfigField[];
      if (configRes.ok) dbConfig = ((await configRes.json()).config ?? {}) as Record<string, unknown>;
      if (statusRes.ok) {
        const body = await statusRes.json();
        dbStatus = {
          active: !!body.active,
          ready: !!body.status?.ready,
          error: body.status?.error,
          capabilities: body.status?.capabilities,
        };
      }
    } catch (err) {
      dbMessage = `Load failed: ${(err as Error).message}`;
    }
  }

  async function saveDbDriver(slug: string): Promise<void> {
    dbSaving = true;
    dbMessage = '';
    try {
      const payload: Record<string, unknown> = {};
      for (const field of dbSchema) {
        const v = dbConfig[field.key];
        if (field.type === 'password' && (v === '' || v == null)) continue;
        payload[field.key] = v;
      }
      const r = await fetch(`${BASE}/api/db-drivers/${encodeURIComponent(slug)}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: payload }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      dbMessage = body.error ? `Saved (start failed: ${body.error})` : '✓ Saved';
      // Refresh status — `running` flips when this driver was already active.
      await loadDbDriver(slug);
    } catch (err) {
      dbMessage = `Failed: ${(err as Error).message}`;
    } finally {
      dbSaving = false;
      setTimeout(() => (dbMessage = ''), 4000);
    }
  }

  async function activateDbDriver(slug: string): Promise<void> {
    dbActivating = true;
    dbMessage = '';
    try {
      const r = await fetch(`${BASE}/api/db-drivers/${encodeURIComponent(slug)}/activate`, {
        method: 'POST',
      });
      const body = await r.json();
      if (!body.ok) {
        // Backend auto-reverted to the previous driver — surface the reason.
        dbMessage = `✗ Activation failed: ${body.error ?? 'unknown error'} — kept previous driver`;
      } else {
        dbMessage = '✓ Activated';
      }
      await loadDbDriver(slug);
      await fetchList();
      if (selected) selected = items.find((i) => i.id === selected!.id) ?? selected;
    } catch (err) {
      dbMessage = `Failed: ${(err as Error).message}`;
    } finally {
      dbActivating = false;
      setTimeout(() => (dbMessage = ''), 6000);
    }
  }

  function setDbBool(key: string, ev: Event): void {
    dbConfig[key] = (ev.currentTarget as HTMLInputElement).checked;
    dbConfig = dbConfig;
  }

  let dbLoadedFor = '';
  $: if (selected && selected.type === 'db-driver' && dbLoadedFor !== selected.slug) {
    dbLoadedFor = selected.slug;
    void loadDbDriver(selected.slug);
  } else if (!selected) {
    dbLoadedFor = '';
  }

  let waTestPhone = '';
  let waTestText = '';
  let waTestSending = false;
  let waTestResult = '';

  async function pollWhatsAppStatus(): Promise<void> {
    try {
      const r = await fetch(`${BASE}/api/notifications/whatsapp/qr`);
      if (!r.ok) { whatsappStatus = null; return; }
      const data = (await r.json()) as WhatsAppStatus;
      whatsappStatus = data;
      if (data.qr) {
        const QR = await import('qrcode');
        whatsappQrDataUrl = await QR.toDataURL(data.qr, {
          width: 280,
          margin: 1,
          color: { dark: '#0E1018', light: '#ffffff' },
        });
      } else {
        whatsappQrDataUrl = null;
      }
    } catch {
      whatsappStatus = null;
    }
  }

  async function loadWaConfig(): Promise<void> {
    try {
      const r = await fetch(`${BASE}/api/extensions/item/${encodeURIComponent('whatsapp')}`);
      if (!r.ok) return;
      const { item } = await r.json();
      const cfg = (item?.settings ?? {}) as { allowedNumbers?: string; defaultChat?: string };
      waAllowedNumbers = cfg.allowedNumbers ?? '';
      waDefaultChat = cfg.defaultChat ?? '';
    } catch { /* ignore */ }
  }

  async function loadPairings(): Promise<void> {
    try {
      const [pendRes, apprRes] = await Promise.all([
        fetch(`${BASE}/api/security/pairing/pending`),
        fetch(`${BASE}/api/security/pairing/approved`),
      ]);
      if (pendRes.ok) {
        const { items } = await pendRes.json();
        waPending = (items ?? []).filter((p: PendingPair) => p.platform === 'whatsapp');
      }
      if (apprRes.ok) {
        const { items } = await apprRes.json();
        waApproved = (items ?? []).filter((p: ApprovedPair) => p.platform === 'whatsapp');
      }
    } catch { /* ignore */ }
  }

  function startWhatsAppPolling(): void {
    if (whatsappPollHandle) return;
    pollWhatsAppStatus();
    loadWaConfig();
    loadPairings();
    whatsappPollHandle = setInterval(() => {
      pollWhatsAppStatus();
      loadPairings();
    }, 2500);
  }
  function stopWhatsAppPolling(): void {
    if (whatsappPollHandle) {
      clearInterval(whatsappPollHandle);
      whatsappPollHandle = null;
    }
    whatsappStatus = null;
    whatsappQrDataUrl = null;
    waPending = [];
    waApproved = [];
    waConfigMessage = '';
    waTestResult = '';
  }

  async function saveWaConfig(): Promise<void> {
    waConfigSaving = true;
    waConfigMessage = '';
    try {
      const r = await fetch(`${BASE}/api/channels/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'whatsapp',
          config: {
            allowedNumbers: waAllowedNumbers.trim(),
            defaultChat: waDefaultChat.trim(),
          },
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      // Restart provider to pick up the new config.
      await fetch(`${BASE}/api/channels/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'whatsapp' }),
      });
      await fetch(`${BASE}/api/channels/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'whatsapp' }),
      });
      waConfigMessage = '✓ Saved and restarted';
    } catch (err) {
      waConfigMessage = 'Failed: ' + (err as Error).message;
    } finally {
      waConfigSaving = false;
      setTimeout(() => (waConfigMessage = ''), 4000);
    }
  }

  async function approvePairing(code: string): Promise<void> {
    const r = await fetch(`${BASE}/api/security/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) {
      const b = await r.json();
      alert(`Approve failed: ${b.error ?? r.status}`);
      return;
    }
    await loadPairings();
  }

  async function revokePairing(userId: string): Promise<void> {
    if (!confirm(`Revoke access for ${userId}? They'll be back in pairing-code mode next time they write.`)) return;
    const r = await fetch(`${BASE}/api/security/pairing/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'whatsapp', userId }),
    });
    if (!r.ok) {
      const b = await r.json();
      alert(`Revoke failed: ${b.error ?? r.status}`);
      return;
    }
    await loadPairings();
  }

  async function requestFreshQr(): Promise<void> {
    whatsappRequesting = true;
    try {
      await fetch(`${BASE}/api/notifications/whatsapp/request_qr`, { method: 'POST' });
      await pollWhatsAppStatus();
    } finally {
      whatsappRequesting = false;
    }
  }

  async function logoutWhatsApp(): Promise<void> {
    if (!confirm('Log out of WhatsApp? The next pairing will require a new QR scan.')) return;
    await fetch(`${BASE}/api/notifications/whatsapp/logout`, { method: 'POST' });
    await pollWhatsAppStatus();
  }

  async function sendTestMessage(): Promise<void> {
    waTestResult = '';
    if (!waTestPhone || !waTestText) return;
    waTestSending = true;
    try {
      const r = await fetch(`${BASE}/api/channels/whatsapp/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: waTestPhone, message: waTestText }),
      });
      const body = await r.json();
      if (r.ok && body.success) {
        waTestResult = `✓ Sent to ${body.jid}`;
        waTestText = '';
      } else {
        waTestResult = 'Failed: ' + (body.error ?? 'unknown');
      }
    } catch (err) {
      waTestResult = 'Failed: ' + (err as Error).message;
    } finally {
      waTestSending = false;
      setTimeout(() => (waTestResult = ''), 5000);
    }
  }

  // Start/stop polling based on which extension is selected.
  $: if (selected?.slug === 'whatsapp') startWhatsAppPolling(); else stopWhatsAppPolling();

  onMount(() => {
    // Deep link: /extensions?tab=skills is where the old /skills page and
    // every "manage skills" link in the agent drawers now point.
    const wanted = new URLSearchParams(location.search).get('tab');
    if (wanted === 'skills' || wanted === 'installed' || wanted === 'updates') tab = wanted;

    fetchList();
    fetchRepos();
    fetchCatalog();
    fetchStoreStatus();
  });

  onDestroy(() => {
    for (const t of pollTimers) clearTimeout(t);
    pollTimers.clear();
  });
</script>

<!--
  Command bar. Everything that used to be a 190px hero + 90px stat strip +
  100px of chips is one 48px row and one 40px row: search dominates, the two
  rarely-used install paths collapse into the ＋ menu, and the counters live in
  the tab labels where they're read as navigation rather than decoration.
-->
<header class="bar anim">
  <div class="bar-brand">
    <span class="bar-mark" aria-hidden="true">⬡</span>
    <h1 class="bar-title">Extensions</h1>
  </div>

  <div class="bar-search">
    <span class="bar-search-icon" aria-hidden="true">⌕</span>
    <input
      type="text"
      bind:value={search}
      on:input={onSearchInput}
      placeholder={tab === 'skills'
        ? `Search ${skillCount} installed skill${skillCount === 1 ? '' : 's'}…`
        : tab === 'installed'
          ? `Search ${installedCount} installed…`
          : `Search ${discoverCount} extensions, skills, agents, themes…`}
      aria-label="Search extensions"
    />
    {#if search}
      <button class="bar-search-clear" on:click={clearFilters} aria-label="Clear search">×</button>
    {/if}
  </div>

  <div class="bar-plus">
    <button
      class="plus-btn"
      aria-haspopup="menu"
      aria-expanded={showPlusMenu}
      on:click={() => (showPlusMenu = !showPlusMenu)}
      title="Add a repository or install a .kernl bundle"
    >＋</button>
    {#if showPlusMenu}
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="plus-scrim" role="presentation" on:click={() => (showPlusMenu = false)}></div>
      <div class="plus-menu" role="menu">
        <button role="menuitem" on:click={() => { showPlusMenu = false; showUpload = true; }}>
          <span class="plus-menu-icon">↑</span>
          <span>
            <strong>Install bundle</strong>
            <small>A <code>.kernl</code> file from disk or a server path</small>
          </span>
        </button>
        <button role="menuitem" on:click={() => { showPlusMenu = false; showAddRepo = true; }}>
          <span class="plus-menu-icon">⎇</span>
          <span>
            <strong>Add repository</strong>
            <small>Fill the catalog from a public Git URL</small>
          </span>
        </button>
        {#if repos.length > 0}
          <button role="menuitem" on:click={() => { showPlusMenu = false; showRepos = true; }}>
            <span class="plus-menu-icon">⚙</span>
            <span>
              <strong>Manage repositories</strong>
              <small>{repos.length} subscribed</small>
            </span>
          </button>
        {/if}
      </div>
    {/if}
  </div>
</header>

<!-- Tabs + the two filters that survived -->
<nav class="tabs anim d05">
  <div class="tabs-left">
    <button class="tab" class:tab-on={tab === 'discover'} on:click={() => switchTab('discover')}>
      Discover
      {#if discoverCount}<span class="tab-n">{discoverCount}</span>{/if}
    </button>
    <button class="tab" class:tab-on={tab === 'installed'} on:click={() => switchTab('installed')}>
      Installed
      {#if installedCount}<span class="tab-n">{installedCount}</span>{/if}
    </button>
    {#if updatesCount > 0}
      <button class="tab tab-accent" class:tab-on={tab === 'updates'} on:click={() => switchTab('updates')}>
        Updates
        <span class="tab-n tab-n-accent">{updatesCount}</span>
      </button>
    {/if}
    <!-- Skills get their own tab, not just a type filter: what you do with a
         skill (hand it to an agent) has nothing to do with what you do with
         the rest of the grid. -->
    <button class="tab tab-skill" class:tab-on={tab === 'skills'} on:click={() => switchTab('skills')}>
      ✦ Skills
      {#if skillCount}<span class="tab-n tab-n-skill">{skillCount}</span>{/if}
    </button>
  </div>

  <div class="tabs-right" class:tabs-right-hidden={tab === 'skills'}>
    <!-- Type: a menu instead of twelve chips, listing only types that exist -->
    <div class="typesel">
      <button class="typesel-btn" aria-expanded={typeMenuOpen} on:click={() => (typeMenuOpen = !typeMenuOpen)}>
        {filterType ? `${metaOf(filterType).icon} ${metaOf(filterType).label}` : 'All types'}
        <span class="typesel-caret" aria-hidden="true">▾</span>
      </button>
      {#if typeMenuOpen}
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="plus-scrim" role="presentation" on:click={() => (typeMenuOpen = false)}></div>
        <div class="typesel-menu" role="menu">
          <button role="menuitem" class:typesel-on={filterType === ''} on:click={() => setType('')}>
            All types
          </button>
          {#each TYPE_ORDER.filter((t) => (typeCounts[t] ?? 0) > 0) as t}
            <button role="menuitem" class:typesel-on={filterType === t} on:click={() => setType(t)}>
              <span class="typesel-glyph" style="color: {metaOf(t).tint}">{metaOf(t).icon}</span>
              {metaOf(t).label}
              <span class="typesel-n">{typeCounts[t]}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Price: the one axis people actually filter a store by -->
    <div class="seg" role="group" aria-label="Price">
      <button class:seg-on={priceFilter === ''} on:click={() => (priceFilter = '')}>All</button>
      <button class:seg-on={priceFilter === 'free'} on:click={() => (priceFilter = 'free')}>Free</button>
      <button class:seg-on={priceFilter === 'paid'} on:click={() => (priceFilter = 'paid')}>Paid</button>
    </div>

    {#if tab === 'installed'}
      <div class="seg" role="group" aria-label="Status">
        <button class:seg-on={filterStatus === ''} on:click={() => { filterStatus = ''; }}>Any</button>
        {#each STATUS_ORDER as s}
          <button
            class:seg-on={filterStatus === s}
            on:click={() => { filterStatus = filterStatus === s ? '' : s; }}
          >{STATUS_META[s].label.charAt(0) + STATUS_META[s].label.slice(1).toLowerCase()}</button>
        {/each}
      </div>
    {/if}
  </div>
</nav>

<!-- Only surfaced when there's something wrong: no stat cards full of zeros. -->
{#if errorCount > 0 && tab !== 'discover'}
  <button class="thin-alert thin-alert-red" on:click={() => { switchTab('installed'); filterStatus = 'error'; }}>
    ⚠︎ {errorCount} extension{errorCount === 1 ? '' : 's'} failed to load — click to review
  </button>
{/if}
{#if !storeReachable}
  <div class="thin-alert">
    ⚠︎ The Kernl store is unreachable{storeError ? ` (${storeError})` : ''} — paid extensions can't be browsed or bought right now.
  </div>
{/if}

<!-- Subscribed git repos — fill the marketplace by URL (path C) -->
{#if showRepos && repos.length > 0}
  <section class="repos-panel anim d05">
    <header class="repos-head">
      <span class="repos-icon">⎇</span>
      <strong>Subscribed repositories</strong>
      <span class="repos-count">{repos.length}</span>
      <button class="repos-close" on:click={() => (showRepos = false)} aria-label="Hide repositories">×</button>
    </header>
    <div class="repos-grid">
      {#each repos as repo (repo.id)}
        <article class="repo-card" class:repo-card-busy={busyRepoId === repo.id} class:repo-card-error={!!repo.sync_error}>
          <div class="repo-row">
            <div class="repo-name">
              <a href={repo.url} target="_blank" rel="noopener noreferrer">{repo.name}</a>
              {#if repo.ref}<span class="repo-ref">@{repo.ref}</span>{/if}
            </div>
            <div class="repo-meta">
              <span class="repo-pill repo-pill-items">{repo.items_found} item{repo.items_found === 1 ? '' : 's'}</span>
              <span class="repo-pill repo-pill-sync">synced {fmtRelative(repo.last_synced_at)}</span>
            </div>
          </div>
          {#if repo.sync_error}
            <div class="repo-err">⚠︎ {repo.sync_error}</div>
          {/if}
          <div class="repo-actions">
            <button class="repo-btn" disabled={busyRepoId === repo.id} on:click={() => syncRepo(repo.id)}>
              ↻ Sync
            </button>
            <button class="repo-btn repo-btn-primary" disabled={busyRepoId === repo.id || repo.items_found === 0} on:click={() => installAllFromRepo(repo)}>
              ✦ Install all ({repo.items_found})
            </button>
            <button class="repo-btn repo-btn-danger" disabled={busyRepoId === repo.id} on:click={() => removeRepo(repo.id, repo.name)}>
              × Remove
            </button>
          </div>
        </article>
      {/each}
    </div>
  </section>
{/if}

<!-- Add repository modal -->
{#if showAddRepo}
  <div class="drawer-scrim" role="presentation" on:click={() => (showAddRepo = false)} on:keydown={(e) => e.key === 'Escape' && (showAddRepo = false)}></div>
  <aside class="addrepo-modal" role="dialog" aria-modal="true">
    <header class="addrepo-head">
      <h2>Add catalog repository</h2>
      <button class="drawer-close" on:click={() => (showAddRepo = false)} aria-label="Close">×</button>
    </header>
    <p class="addrepo-hint">
      Paste a public Git URL. The kernel clones the repo (shallow) into <code>data/catalog-cache/</code>
      and walks for <code>SKILL.md</code> (Anthropic Claude Code), <code>SKILL.json</code> (Kernl)
      or <code>extension.json</code> markers. Each marker becomes a catalog item you can install with one click.
    </p>
    <div class="addrepo-form">
      <label>
        <span>Repository URL <em>*</em></span>
        <input type="text" bind:value={newRepoUrl} placeholder="https://github.com/coreyhaines31/marketingskills" />
      </label>
      <label>
        <span>Branch / tag / commit (optional)</span>
        <input type="text" bind:value={newRepoRef} placeholder="main" />
      </label>
      <label>
        <span>Display name (optional)</span>
        <input type="text" bind:value={newRepoName} placeholder="auto-derived from URL" />
      </label>
      {#if repoError}
        <div class="addrepo-err">⚠︎ {repoError}</div>
      {/if}
      <div class="addrepo-actions">
        <button class="act-btn act-secondary" on:click={() => (showAddRepo = false)} disabled={addingRepo}>Cancel</button>
        <button class="act-btn act-primary" on:click={addRepo} disabled={addingRepo || !newRepoUrl.trim()}>
          {addingRepo ? 'Cloning + scanning…' : 'Subscribe + sync'}
        </button>
      </div>
    </div>
  </aside>
{/if}

<!--
  The grid. One card component for both sources: a store item, a bundled
  extension and an installed module all render the same way, and only the
  primary button differs (Buy / Install / Update / Manage). The card body opens
  the detail — the button acts without opening anything, so acquiring something
  is one click from the grid.
-->
{#if tab === 'skills'}
  <SkillsHub
    query={search}
    showSearch={false}
    on:discover={skillsToDiscover}
    on:addrepo={() => (showAddRepo = true)}
    on:open={(e) => openSkillDetail(e.detail.slug)}
  />
{:else if tab === 'installed' ? loading : catalogLoading}
  <div class="loading">Loading{tab === 'installed' ? ' installed extensions' : ' the catalog'}…</div>
{:else if tab === 'installed' ? loadError : catalogError}
  <div class="error-banner">Failed to load: {tab === 'installed' ? loadError : catalogError}</div>
{:else if cards.length === 0}
  <div class="empty">
    <div class="empty-icon">⬡</div>
    {#if filtersActive}
      <div class="empty-title">No matches</div>
      <p class="empty-sub">
        Nothing in {tab === 'installed' ? 'your installed extensions' : 'the catalog'} matches
        {#if search}“{search}”{:else}the current filter{/if}.
      </p>
      <div class="empty-actions">
        <button class="btn-install btn-install-ghost" on:click={clearFilters}>Clear filters</button>
        {#if tab === 'installed' && search}
          <button class="btn-install" on:click={() => switchTab('discover')}>
            Search the catalog instead
          </button>
        {/if}
      </div>
    {:else if tab === 'installed'}
      <div class="empty-title">Nothing installed yet</div>
      <p class="empty-sub">Browse the catalog and install something — it's one click.</p>
      <div class="empty-actions">
        <button class="btn-install" on:click={() => switchTab('discover')}>Browse the catalog</button>
      </div>
    {:else if hiddenInstalled > 0}
      <!-- Not an empty catalog: everything available is already installed. -->
      <div class="empty-title">You've got everything</div>
      <p class="empty-sub">
        All {hiddenInstalled} extensions in your catalog are installed. Add a Git
        repository for more, or check the store for premium ones.
      </p>
      <div class="empty-actions">
        <button class="btn-install" on:click={() => (showAddRepo = true)}>Add repository</button>
        <button class="btn-install btn-install-ghost" on:click={() => switchTab('installed')}>
          See what's installed
        </button>
      </div>
    {:else}
      <div class="empty-title">The catalog is empty</div>
      <p class="empty-sub">
        Add a Git repository to fill it, or install a <code>.kernl</code> bundle directly.
      </p>
      <div class="empty-actions">
        <button class="btn-install" on:click={() => (showAddRepo = true)}>Add repository</button>
        <button class="btn-install btn-install-ghost" on:click={() => (showUpload = true)}>Install bundle</button>
      </div>
    {/if}
  </div>
{:else}
  <!--
    All-Access first: one strip, real prices from the store, shown only to
    someone who doesn't already have it. It's the highest-value thing on the
    page, so it gets the top slot and the only gradient on the screen.
  -->
  {#if tab === 'discover' && forSaleCount > 0 && allAccess?.monthly?.price_cents}
    <section class="aa anim">
      <div class="aa-glow" aria-hidden="true"></div>
      <div class="aa-body">
        <div class="aa-kicker">All-Access</div>
        <h2 class="aa-title">
          {#if ownedCount > 0}
            Unlock the other {forSaleCount} premium extension{forSaleCount === 1 ? '' : 's'}
          {:else}
            Unlock all {forSaleCount} premium extension{forSaleCount === 1 ? '' : 's'}
          {/if}
        </h2>
        <p class="aa-sub">
          Every paid extension, plus everything released while you're subscribed.
          Cancel whenever — extensions you bought outright stay yours.
        </p>
      </div>
      <div class="aa-buy">
        <div class="aa-price">
          <span class="aa-price-sym">{priceParts(allAccess.monthly.price_cents, allAccess.monthly.currency).sym}</span>
          <span class="aa-price-num">{priceParts(allAccess.monthly.price_cents, allAccess.monthly.currency).num}</span>
          <span class="aa-price-per">/mo</span>
        </div>
        {#if allAccess.yearly?.price_cents}
          <div class="aa-alt">
            or {fmtMoney(allAccess.yearly.price_cents, allAccess.yearly.currency)}/year
          </div>
        {/if}
        <a class="aa-cta" href={PRICING_URL} target="_blank" rel="noopener noreferrer">
          Get All-Access
        </a>
      </div>
    </section>
  {/if}

  <!--
    The storefront rail. Paid items are goods, not config rows: big mark, the
    price as a tabular numeral, what you actually get, and a full-width CTA.
    Free items stay in the quiet grid below — the contrast is what sells.
  -->
  {#if shelfCards.length > 0}
    <section class="shelf anim d05">
      <header class="sec-head">
        <span class="sec-rule" aria-hidden="true"></span>
        <h2 class="sec-title">Premium</h2>
        <span class="sec-n">{shelfCards.length}</span>
        {#if !storeReachable}
          <span class="sec-note">store unreachable</span>
        {/if}
      </header>

      <div class="shelf-grid">
        {#each shelfCards as vm, i (vm.key)}
          {@const meta = metaOf(vm.type)}
          {@const act = actionFor(vm)}
          {@const purchase = purchases[vm.slug]}
          {@const pp = priceParts(vm.priceCents, vm.currency)}
          <article
            class="pcard"
            class:pcard-owned={vm.status === 'owned'}
            style="--card-tint: {meta.tint}; --stagger: {i * 45}ms;"
          >
            <div class="pcard-sheen" aria-hidden="true"></div>

            <button type="button" class="pcard-body" on:click={() => openCard(vm)}>
              <div class="pcard-top">
                <span class="pcard-mark">{vm.icon}</span>
                {#if vm.status === 'owned'}
                  <span class="pcard-owned-tag">✓ Owned</span>
                {:else if vm.priceCents > 0}
                  <span class="pcard-price">
                    <span class="pcard-price-sym">{pp.sym}</span><span class="pcard-price-num">{pp.num}</span>
                  </span>
                {/if}
              </div>

              <h3 class="pcard-name">{vm.name}</h3>
              <div class="pcard-meta">{meta.label} · v{vm.version}</div>
              <p class="pcard-desc">{vm.description || '(no description)'}</p>

              <div class="pcard-trust">
                {#if vm.status === 'owned'}
                  <span class="trust">Covered by your license</span>
                {:else}
                  <span class="trust">One-time — yours forever</span>
                {/if}
                <span class="trust">Signed bundle</span>
              </div>
            </button>

            <div class="pcard-foot">
              <button
                class="pcard-cta"
                class:pcard-cta-owned={vm.status === 'owned'}
                disabled={act.disabled}
                on:click={() => onCardAction(vm, act.kind)}
              >{act.label}</button>
            </div>

            {#if purchase?.state === 'failed' && purchase.error}
              <div class="card-error-msg">⚠︎ {purchase.error}</div>
            {:else if purchase?.state === 'pending'}
              <div class="pcard-hint">Finish the payment in the tab that opened — this card updates itself.</div>
            {/if}
          </article>
        {/each}
      </div>
    </section>
  {/if}

  {#if tab === 'discover' && gridCards.length > 0}
    <header class="sec-head anim d1">
      <span class="sec-rule" aria-hidden="true"></span>
      <h2 class="sec-title">Free</h2>
      <span class="sec-n">{gridCards.length}</span>
      {#if hiddenInstalled > 0}
        <button class="sec-link" on:click={() => switchTab('installed')}>
          {hiddenInstalled} already installed — hidden
        </button>
      {/if}
    </header>
  {/if}

  <div class="grid anim d1">
    {#each gridCards as vm (vm.key)}
      {@const meta = metaOf(vm.type)}
      {@const act = actionFor(vm)}
      {@const purchase = purchases[vm.slug]}
      <article
        class="card"
        class:card-disabled={vm.status === 'disabled'}
        class:card-error={vm.status === 'error'}
        class:card-paid={vm.status === 'for_sale'}
        style="--card-tint: {meta.tint};"
      >
        <div class="card-stripe"></div>

        <!-- Body opens the detail; the action button below is separate so it
             never requires opening a drawer first. -->
        <button type="button" class="card-body" on:click={() => openCard(vm)}>
          <div class="card-head">
            <div class="card-icon">
              {#if vm.logo && vm.installed}
                <img src={logoUrl(vm.installed)} alt="" class="card-icon-img" loading="lazy" />
              {:else if vm.logo && /^https?:\/\//i.test(vm.logo)}
                <img src={vm.logo} alt="" class="card-icon-img" loading="lazy" />
              {:else}
                {vm.icon}
              {/if}
            </div>
            <div class="card-head-text">
              <div class="card-name">{vm.name}</div>
              <div class="card-sub">
                <span>{meta.label}</span>
                <span class="sep">·</span>
                <span>v{vm.version}</span>
                {#if vm.updateAvailable && vm.installedVersion}
                  <span class="sep">·</span>
                  <span class="card-from">from v{vm.installedVersion}</span>
                {/if}
              </div>
            </div>
            {#if vm.status === 'for_sale' || vm.status === 'owned'}
              <span class="card-badge" class:card-badge-owned={vm.status === 'owned'}>
                {priceBadge(vm)}
              </span>
            {:else if isInstalledStatus(vm.status)}
              <span class="card-dot card-dot-{vm.status}" title={STATUS_LABEL[vm.status]}></span>
            {/if}
          </div>

          <p class="card-desc">{vm.description || '(no description)'}</p>
        </button>

        <!-- A paid extension that installed cleanly but has no licence looks
             identical to a working one: the card is there, the version is
             there, and only its tools are missing. Say which feature is
             absent, and link to the page that fixes it — the failure is one
             click from its own remedy and nothing used to connect them. -->
        {#if vm.installed?.entitlement && !vm.installed.entitlement.licensed}
          <a class="card-locked" href="/settings/license">
            <span class="card-locked-icon" aria-hidden="true">🔒</span>
            <span>
              Requires <code>{vm.installed.entitlement.required_feature}</code> —
              your licence does not include it. Add a licence
            </span>
          </a>
        {/if}

        <div class="card-foot">
          <button
            class="card-act"
            class:card-act-buy={act.kind === 'buy'}
            class:card-act-update={act.kind === 'update'}
            class:card-act-ghost={act.kind === 'manage' || act.kind === 'pricing'}
            disabled={act.disabled}
            on:click={() => onCardAction(vm, act.kind)}
          >
            {act.label}
          </button>
          <!-- A for_sale card is by definition not covered, so the presence of
               some other license is irrelevant here. -->
          {#if vm.provider === 'store' && act.kind === 'buy'}
            <a class="card-aa" href={PRICING_URL} target="_blank" rel="noopener noreferrer">
              or All-Access
            </a>
          {/if}
        </div>

        {#if purchase?.state === 'failed' && purchase.error}
          <div class="card-error-msg">⚠︎ {purchase.error}</div>
        {:else if vm.status === 'error' && vm.error}
          <div class="card-error-msg">⚠︎ {vm.error}</div>
        {/if}
      </article>
    {/each}
  </div>
{/if}

<!-- Catalog preview: the drawer for something that isn't installed yet -->
{#if previewed}
  {@const vm = previewed}
  {@const meta = metaOf(vm.type)}
  {@const act = actionFor(vm)}
  <div
    class="drawer-scrim"
    role="presentation"
    on:click={() => (previewed = null)}
    on:keydown={(e) => e.key === 'Escape' && (previewed = null)}
  ></div>
  <aside class="drawer" role="dialog" aria-modal="true" style="--card-tint: {meta.tint};">
    <div class="drawer-ribbon"></div>
    <header class="drawer-head">
      <div class="drawer-title">
        <div class="drawer-icon">{vm.icon}</div>
        <div>
          <div class="drawer-name">{vm.name}</div>
          <div class="drawer-id mono">{vm.slug}</div>
        </div>
      </div>
      <button class="drawer-close" on:click={() => (previewed = null)} aria-label="Close">×</button>
    </header>

    <div class="drawer-tags">
      <span class="tag tag-type">{meta.label}</span>
      <span class="tag">v{vm.version}</span>
      {#if vm.catalog?.manifest.license}<span class="tag tag-muted">{vm.catalog.manifest.license}</span>{/if}
      <span class="tag tag-price">
        {vm.status === 'for_sale' || vm.status === 'owned' ? priceBadge(vm) : fmtMoney(vm.priceCents, vm.currency)}
      </span>
      {#if vm.status === 'owned'}<span class="tag tag-status tag-status-active">OWNED</span>{/if}
      {#if vm.provider && vm.provider !== 'installed'}<span class="tag tag-muted">{vm.provider}</span>{/if}
    </div>

    <p class="drawer-desc">{vm.description || '(no description)'}</p>

    <div class="drawer-actions">
      <button
        class="act-btn act-primary"
        disabled={act.disabled}
        on:click={() => onCardAction(vm, act.kind)}
      >{act.label}</button>
      {#if vm.status === 'for_sale' && act.kind === 'buy'}
        <a class="act-btn act-secondary" href={PRICING_URL} target="_blank" rel="noopener noreferrer">
          See All-Access
        </a>
      {/if}
    </div>

    {#if vm.status === 'for_sale' && act.kind === 'buy'}
      <section class="drawer-section">
        <h3>How buying works</h3>
        <p class="drawer-note">
          Checkout opens in a new tab. When the payment clears, this kernel picks
          up the license on its own and installs {vm.name} — you never handle a
          license key. If you close the tab mid-payment, it resumes here.
        </p>
      </section>
    {/if}

    {#if vm.catalog?.manifest.permissions?.length}
      <section class="drawer-section">
        <h3>Permissions requested</h3>
        <div class="perm-list">
          {#each vm.catalog.manifest.permissions as p}
            <span class="tag tag-perm mono">{p}</span>
          {/each}
        </div>
      </section>
    {/if}

    {#if vm.author}
      <section class="drawer-section">
        <h3>Author</h3>
        <p class="drawer-note">{vm.author}</p>
      </section>
    {/if}
  </aside>
{/if}

<!-- Detail drawer -->
{#if selected}
  {@const sel = selected}
  {@const meta = metaOf(sel.type)}
  <div
    class="drawer-scrim"
    role="presentation"
    on:click={() => (selected = null)}
    on:keydown={(e) => e.key === 'Escape' && (selected = null)}
  ></div>
  <aside class="drawer" class:drawer-wide={sel.slug === 'claude-code'} role="dialog" aria-modal="true" style="--card-tint: {meta.tint};">
    <div class="drawer-ribbon"></div>

    <header class="drawer-head">
      <div class="drawer-title">
        <div class="drawer-icon">
          {#if sel.manifest?.logo}
            <img
              src={logoUrl(sel)}
              alt=""
              class="drawer-icon-img"
            />
          {:else}
            {sel.manifest?.icon ?? meta.icon}
          {/if}
        </div>
        <div>
          <div class="drawer-name">{sel.name}</div>
          <div class="drawer-id mono">{sel.id}</div>
        </div>
      </div>
      <button class="drawer-close" on:click={() => (selected = null)} aria-label="Close">×</button>
    </header>

    <div class="drawer-tags">
      <span class="tag tag-type">{meta.label}</span>
      <span class="tag tag-status tag-status-{sel.status}">{STATUS_META[sel.status].label}</span>
      <span class="tag">v{sel.version}</span>
      {#if sel.manifest?.license}<span class="tag tag-muted">{sel.manifest.license}</span>{/if}
      <span class="tag tag-price">{fmtPrice(sel.manifest)}</span>
    </div>

    {#if sel.manifest?.description}
      <p class="drawer-desc">{sel.manifest.description}</p>
    {/if}

    <div class="drawer-actions">
      {#if sel.type !== 'db-driver'}
        <!-- db-driver activation is managed below by its dedicated panel,
             which goes through /api/db-drivers/:slug/activate to enforce
             the single-active-per-kind invariant. The generic enable/disable
             endpoints just flip installed_extensions.status and would bypass
             the registry's lifecycle hooks. -->
        {#if sel.status === 'active'}
          <button class="act-btn act-secondary" on:click={() => doDisable(sel.id)}>Disable</button>
        {:else if sel.manifest?.requires_activation && sel.status === 'installed'}
          <!-- Consent-gated activation. Distinct CTA from regular Enable so the
               user understands they're explicitly opting into a Pro-author's
               extension. -->
          <button class="act-btn act-primary act-activate" on:click={() => doActivate(sel)}>
            ✦ Activate
          </button>
        {:else}
          <button class="act-btn act-primary" on:click={() => doEnable(sel.id)}>Enable</button>
        {/if}
      {/if}
      {#if !sel.manifest?.built_in}
        <button class="act-btn act-danger" on:click={() => doUninstall(sel.id, sel.name)}>Uninstall</button>
      {/if}
    </div>

    {#if sel.manifest?.requires_activation && sel.status === 'installed'}
      <div class="activation-banner">
        <div class="activation-icon">✦</div>
        <div class="activation-text">
          <strong>Pro author extension.</strong>
          This extension stays idle until you explicitly activate it.
          By clicking <em>Activate</em> you confirm you're authorised to use it
          (e.g. you bought a license, you're a contributor, or the author allows it).
        </div>
      </div>
    {/if}

    <!-- ── Install Receipt ─────────────────────────────────────────── -->
    <!-- Cryptographic proof of WHO installed this extension WHEN and from
         WHERE. Local receipt always present (signed by THIS kernel's
         identity). Remote watermark only present when downloaded via a
         watermarking marketplace provider (signed by the SOURCE kernel). -->
    <section class="drawer-section receipt-panel">
      <div class="section-title">
        <span>Install receipt</span>
        {#if sel.install_receipt?.signature}
          <span class="receipt-badge receipt-badge-ok" title="Signed by the installing kernel">
            ✓ signed
          </span>
        {:else}
          <span class="receipt-badge receipt-badge-warn" title="No signature recorded">
            unsigned
          </span>
        {/if}
        {#if sel.install_receipt?.remote_watermark}
          <span class="receipt-badge receipt-badge-wm" title="Watermarked download from a remote source">
            ◈ watermark
          </span>
        {/if}
      </div>

      {#if !sel.install_receipt || Object.keys(sel.install_receipt).length === 0}
        <div class="receipt-empty">
          No receipt recorded — this extension was installed before receipts were enabled (legacy row).
        </div>
      {:else}
        <dl class="receipt-grid">
          <dt>install_id</dt>
          <dd>
            <code class="mono receipt-mono">{sel.install_receipt.install_id}</code>
            <button class="receipt-copy" on:click|stopPropagation={() => copyText(sel.install_receipt?.install_id ?? '')} title="Copy install_id">⎘</button>
          </dd>

          <dt>installed at</dt>
          <dd>
            <span class="mono">{sel.install_receipt.installed_at}</span>
          </dd>

          <dt>bundle_sha256</dt>
          <dd>
            <code class="mono receipt-mono receipt-trunc" title={sel.install_receipt.bundle_sha256}>
              {sel.install_receipt.bundle_sha256}
            </code>
          </dd>

          <dt>install_sha256</dt>
          <dd>
            <code class="mono receipt-mono receipt-trunc" title={sel.install_receipt.install_sha256}>
              {sel.install_receipt.install_sha256}
            </code>
            <button class="receipt-copy" on:click|stopPropagation={() => copyText(sel.install_receipt?.install_sha256 ?? '')} title="Copy install_sha256">⎘</button>
          </dd>

          <dt>kernel_identity</dt>
          <dd>
            <code class="mono receipt-mono receipt-trunc" title={sel.install_receipt.kernel_identity}>
              {sel.install_receipt.kernel_identity}
            </code>
          </dd>

          <dt>signature</dt>
          <dd>
            {#if sel.install_receipt.signature}
              <code class="mono receipt-mono receipt-trunc" title={sel.install_receipt.signature}>
                {sel.install_receipt.signature}
              </code>
              <button class="receipt-copy" on:click|stopPropagation={() => copyText(sel.install_receipt?.signature ?? '')} title="Copy signature">⎘</button>
            {:else}
              <span class="receipt-empty-inline">— not signed —</span>
            {/if}
          </dd>

          <dt>source</dt>
          <dd>
            <code class="mono receipt-mono">{sel.install_receipt.source?.type ?? 'unknown'}</code>
            {#if sel.install_receipt.source && Object.keys(sel.install_receipt.source).length > 1}
              <span class="receipt-source-extra">
                {Object.entries(sel.install_receipt.source).filter(([k]) => k !== 'type').map(([k, v]) => `${k}=${v}`).join(' · ')}
              </span>
            {/if}
          </dd>
        </dl>

        {#if sel.install_receipt.remote_watermark}
          <div class="watermark-card">
            <div class="watermark-head">
              <span class="watermark-icon">◈</span>
              <strong>Remote download watermark</strong>
              <span class="watermark-pill">verifiable</span>
            </div>
            <dl class="receipt-grid receipt-grid-tight">
              <dt>download_id</dt>
              <dd>
                <code class="mono receipt-mono">{sel.install_receipt.remote_watermark.download_id}</code>
                <button class="receipt-copy" on:click|stopPropagation={() => copyText(sel.install_receipt?.remote_watermark?.download_id ?? '')} title="Copy download_id">⎘</button>
              </dd>
              <dt>source identity</dt>
              <dd>
                <code class="mono receipt-mono receipt-trunc" title={sel.install_receipt.remote_watermark.source_fp}>
                  {sel.install_receipt.remote_watermark.source_fp}
                </code>
              </dd>
              <dt>downloader</dt>
              <dd>
                <code class="mono receipt-mono receipt-trunc" title={sel.install_receipt.remote_watermark.downloader_fp}>
                  {sel.install_receipt.remote_watermark.downloader_fp}
                </code>
              </dd>
              <dt>issued at</dt>
              <dd><span class="mono">{sel.install_receipt.remote_watermark.ts}</span></dd>
              <dt>signature</dt>
              <dd>
                <code class="mono receipt-mono receipt-trunc" title={sel.install_receipt.remote_watermark.signature}>
                  {sel.install_receipt.remote_watermark.signature}
                </code>
              </dd>
            </dl>
          </div>
        {/if}

        <div class="receipt-actions">
          <button class="receipt-btn" on:click|stopPropagation={() => copyText(JSON.stringify(sel.install_receipt, null, 2))}>
            Copy full receipt JSON
          </button>
          <button class="receipt-btn" on:click|stopPropagation={() => downloadJson(`receipt-${sel.slug}.json`, sel.install_receipt)}>
            Download .json
          </button>
        </div>
      {/if}
    </section>

    {#if sel.type === 'llm-provider'}
      <!-- LLM provider config form, schema-driven via /api/llm-providers/:slug/schema.
           For the `defaultModel` field we additionally fetch /models so the user
           can pick from the live catalog instead of typing a model id by hand. -->
      <section class="drawer-section llm-panel">
        <div class="section-title">Configuration</div>
        {#if llmSchema.length === 0}
          <div class="llm-hint">Loading…</div>
        {:else}
          <div class="llm-form">
            {#each llmSchema as field (field.key)}
              <div class="llm-field">
                <label class="llm-label" for={`llm-f-${field.key}`}>
                  {field.label}
                  {#if field.required}<span class="llm-req">*</span>{/if}
                </label>

                {#if field.key === 'defaultModel' && llmModels.length > 0 && llmModelMode === 'list'}
                  <div class="llm-row">
                    <select
                      class="llm-input"
                      bind:value={llmConfig[field.key]}
                    >
                      <option value="">— use provider default —</option>
                      {#each llmModels as m (m)}
                        <option value={m}>{m}</option>
                      {/each}
                    </select>
                    <button
                      type="button"
                      class="llm-btn-mini"
                      title="Refresh model list"
                      on:click={() => refreshLlmModels(sel.slug)}
                      disabled={llmLoadingModels}
                    >↻</button>
                    <button
                      type="button"
                      class="llm-btn-mini"
                      title="Type a custom model id"
                      on:click={() => (llmModelMode = 'custom')}
                    >✎</button>
                  </div>
                {:else if field.key === 'defaultModel' && (llmModels.length === 0 || llmModelMode === 'custom')}
                  <div class="llm-row">
                    <input
                      class="llm-input"
                      type="text"
                      placeholder={field.placeholder ?? ''}
                      bind:value={llmConfig[field.key]}
                    />
                    {#if llmModels.length > 0}
                      <button
                        type="button"
                        class="llm-btn-mini"
                        title="Pick from list"
                        on:click={() => (llmModelMode = 'list')}
                      >☰</button>
                    {:else}
                      <button
                        type="button"
                        class="llm-btn-mini"
                        title="Discover available models"
                        on:click={() => refreshLlmModels(sel.slug)}
                        disabled={llmLoadingModels}
                      >↻</button>
                    {/if}
                  </div>
                {:else if field.type === 'password'}
                  <input
                    class="llm-input"
                    type="password"
                    placeholder={field.placeholder ?? '(unchanged)'}
                    bind:value={llmConfig[field.key]}
                  />
                {:else if field.type === 'select' && field.options}
                  <select class="llm-input" bind:value={llmConfig[field.key]}>
                    {#each field.options as opt (opt.value)}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                {:else if field.type === 'boolean'}
                  <input
                    type="checkbox"
                    checked={Boolean(llmConfig[field.key])}
                    on:change={(e) => setLlmBool(field.key, e)}
                  />
                {:else if field.type === 'number'}
                  <input
                    class="llm-input"
                    type="number"
                    placeholder={field.placeholder ?? ''}
                    bind:value={llmConfig[field.key]}
                  />
                {:else if field.type === 'textarea'}
                  <textarea
                    class="llm-input llm-textarea"
                    placeholder={field.placeholder ?? ''}
                    bind:value={llmConfig[field.key]}
                  ></textarea>
                {:else}
                  <input
                    class="llm-input"
                    type="text"
                    placeholder={field.placeholder ?? ''}
                    bind:value={llmConfig[field.key]}
                  />
                {/if}

                {#if field.description}
                  <div class="llm-help">{field.description}</div>
                {/if}
              </div>
            {/each}

            <div class="llm-actions">
              <button class="act-btn act-primary" on:click={() => saveLlmProvider(sel.slug)} disabled={llmSaving}>
                {llmSaving ? 'Saving…' : 'Save & reload'}
              </button>
              {#if llmMessage}
                <span class="llm-msg">{llmMessage}</span>
              {/if}
            </div>
          </div>
        {/if}
      </section>
    {/if}

    {#if sel.type === 'db-driver'}
      <!-- DB driver config + activation. The "Activate" button enforces the
           single-active-per-kind invariant on the backend; if the new driver
           fails to come up, the kernel auto-reverts to the previous one and
           the toast surfaces the reason. -->
      <section class="drawer-section llm-panel">
        <div class="section-title">
          {#if dbStatus?.active}
            <span style="color: var(--green);">● Active</span>
            {#if dbStatus.ready}<span style="color: var(--text-3); font-weight: normal;"> · ready</span>{/if}
            {#if dbStatus.error}<span style="color: var(--red); font-weight: normal;"> · {dbStatus.error}</span>{/if}
          {:else}
            <span style="color: var(--text-3);">Inactive</span>
          {/if}
        </div>

        {#if dbStatus?.capabilities}
          <div class="llm-help" style="margin-bottom: 0.75rem;">
            Capabilities:
            {#each Object.entries(dbStatus.capabilities) as [k, v]}
              <span style="color: {v ? 'var(--green)' : 'var(--text-3)'}; margin-right: 0.4em;">{v ? '●' : '○'} {k}</span>
            {/each}
          </div>
        {/if}

        {#if dbSchema.length === 0}
          <div class="llm-hint">No configuration required for this driver.</div>
        {:else}
          <div class="llm-form">
            {#each dbSchema as field (field.key)}
              <div class="llm-field">
                <label class="llm-label" for={`db-f-${field.key}`}>
                  {field.label}
                  {#if field.required}<span class="llm-req">*</span>{/if}
                </label>
                {#if field.type === 'password'}
                  <input class="llm-input" type="password" placeholder={field.placeholder ?? '(unchanged)'} bind:value={dbConfig[field.key]} />
                {:else if field.type === 'select' && field.options}
                  <select class="llm-input" bind:value={dbConfig[field.key]}>
                    {#each field.options as opt (opt.value)}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                {:else if field.type === 'boolean'}
                  <input type="checkbox" checked={Boolean(dbConfig[field.key])} on:change={(e) => setDbBool(field.key, e)} />
                {:else if field.type === 'number'}
                  <input class="llm-input" type="number" placeholder={field.placeholder ?? ''} bind:value={dbConfig[field.key]} />
                {:else if field.type === 'textarea'}
                  <textarea class="llm-input llm-textarea" placeholder={field.placeholder ?? ''} bind:value={dbConfig[field.key]}></textarea>
                {:else}
                  <input class="llm-input" type="text" placeholder={field.placeholder ?? ''} bind:value={dbConfig[field.key]} />
                {/if}
                {#if field.description}<div class="llm-help">{field.description}</div>{/if}
              </div>
            {/each}
          </div>
        {/if}

        <div class="llm-actions">
          {#if dbSchema.length > 0}
            <button class="act-btn act-secondary" on:click={() => saveDbDriver(sel.slug)} disabled={dbSaving}>
              {dbSaving ? 'Saving…' : 'Save config'}
            </button>
          {/if}
          {#if !dbStatus?.active}
            <button class="act-btn act-primary" on:click={() => activateDbDriver(sel.slug)} disabled={dbActivating}>
              {dbActivating ? 'Activating…' : 'Activate'}
            </button>
          {:else}
            <span class="llm-hint">This driver is currently serving graph queries.</span>
          {/if}
          {#if dbMessage}
            <span class="llm-msg">{dbMessage}</span>
          {/if}
        </div>
      </section>
    {/if}

    {#if sel.slug === 'claude-code'}
      <!-- Claude Code SDK — skills / plugins / MCPs / marketplaces (per-agent scoping).
           These are features of the SDK transport only: the Anthropic API provider
           (`claude`) doesn't see them, MCPs at kernel-level go through mcp-bridge.  -->
      <section class="drawer-section cc-panel">
        <HostIntegrations />
      </section>
    {/if}

    {#if sel.slug === 'whatsapp'}
      <!-- 1 · Pair a device ──────────────────────────────────────── -->
      <section class="drawer-section wa-panel">
        <div class="section-title">Pair a device</div>
        {#if !whatsappStatus}
          <div class="wa-hint">Loading status…</div>
        {:else if whatsappStatus.connected}
          <div class="wa-card wa-card-ok">
            <div class="wa-dot"></div>
            <div>
              <div class="wa-title">Connected</div>
              <div class="wa-sub">A device is paired and messages can flow.</div>
            </div>
          </div>
          <div class="wa-actions">
            <button class="act-btn act-secondary" on:click={requestFreshQr} disabled={whatsappRequesting}>Re-pair device</button>
            <button class="act-btn act-danger" on:click={logoutWhatsApp}>Log out</button>
          </div>
        {:else if whatsappQrDataUrl}
          <div class="wa-qr-wrap">
            <img class="wa-qr" src={whatsappQrDataUrl} alt="WhatsApp pairing QR" />
          </div>
          <ol class="wa-steps">
            <li>Open <b>WhatsApp</b> on your phone.</li>
            <li>Tap <b>Settings → Linked Devices</b>.</li>
            <li>Tap <b>Link a Device</b> and scan this QR.</li>
          </ol>
          <div class="wa-actions">
            <button class="act-btn act-secondary" on:click={requestFreshQr} disabled={whatsappRequesting}>New QR</button>
          </div>
        {:else if whatsappStatus.error}
          <div class="wa-card wa-card-err">
            <div class="wa-dot err"></div>
            <div>
              <div class="wa-title">Error</div>
              <div class="wa-sub">{whatsappStatus.error}</div>
            </div>
          </div>
          <div class="wa-actions">
            <button class="act-btn act-primary" on:click={requestFreshQr} disabled={whatsappRequesting}>Retry</button>
          </div>
        {:else}
          <div class="wa-card">
            <div class="wa-dot pending"></div>
            <div>
              <div class="wa-title">Waiting for bridge…</div>
              <div class="wa-sub">Make sure the whatsapp-bridge sidecar is running.</div>
            </div>
          </div>
          <div class="wa-actions">
            <button class="act-btn act-primary" on:click={requestFreshQr} disabled={whatsappRequesting}>Request QR</button>
          </div>
        {/if}
      </section>

      <!-- 2 · Configuration ─────────────────────────────────────── -->
      {#if whatsappStatus?.connected}
        <section class="drawer-section wa-panel">
          <div class="section-title">Configuration</div>
          <label class="wa-field">
            <span class="wa-field-label">Allowed numbers</span>
            <input
              class="wa-input"
              type="text"
              bind:value={waAllowedNumbers}
              placeholder="* (anyone) or 5491123456789,5491198765432"
            />
            <span class="wa-field-hint">
              Gatekeeps who can talk to the bot. Use <code>*</code> to accept
              everyone, or comma-separated international numbers (no <code>+</code>).
              First-time senders still go through a pairing-code approval below.
            </span>
          </label>
          <label class="wa-field">
            <span class="wa-field-label">Default chat</span>
            <input
              class="wa-input"
              type="text"
              bind:value={waDefaultChat}
              placeholder="5491123456789@s.whatsapp.net"
            />
            <span class="wa-field-hint">
              Where proactive notifications are sent (e.g. agent alerts).
            </span>
          </label>
          <div class="wa-actions">
            <button class="act-btn act-primary" on:click={saveWaConfig} disabled={waConfigSaving}>
              {waConfigSaving ? 'Saving…' : 'Save & restart'}
            </button>
            {#if waConfigMessage}
              <span class="wa-save-msg">{waConfigMessage}</span>
            {/if}
          </div>
        </section>

        <!-- 3 · Pending pairing codes ───────────────────────────── -->
        <section class="drawer-section wa-panel">
          <div class="section-title">
            Pending approvals
            {#if waPending.length}<span class="wa-badge-count">{waPending.length}</span>{/if}
          </div>
          {#if waPending.length === 0}
            <div class="wa-empty">
              Nobody is waiting for approval. When an unknown number messages
              the bot, a pairing code will show up here.
            </div>
          {:else}
            <div class="wa-pair-list">
              {#each waPending as p}
                <div class="wa-pair-row">
                  <div class="wa-pair-code">{p.code}</div>
                  <div class="wa-pair-user">
                    <div class="wa-pair-user-id mono">{p.userId}</div>
                    <div class="wa-pair-user-exp">expires {new Date(p.expiresAt).toLocaleTimeString()}</div>
                  </div>
                  <button class="act-btn act-primary wa-pair-approve" on:click={() => approvePairing(p.code)}>
                    Approve
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <!-- 4 · Approved senders ────────────────────────────────── -->
        <section class="drawer-section wa-panel">
          <div class="section-title">
            Approved senders
            {#if waApproved.length}<span class="wa-badge-count">{waApproved.length}</span>{/if}
          </div>
          {#if waApproved.length === 0}
            <div class="wa-empty">No approved senders yet.</div>
          {:else}
            <div class="wa-approved-list">
              {#each waApproved as a}
                <div class="wa-approved-row">
                  <span class="mono">{a.userId}</span>
                  <button class="act-btn act-danger wa-revoke" on:click={() => revokePairing(a.userId)}>
                    Revoke
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <!-- 5 · Test send ────────────────────────────────────────── -->
        <section class="drawer-section wa-panel">
          <div class="section-title">Send test message</div>
          <label class="wa-field">
            <span class="wa-field-label">To (phone number)</span>
            <input
              class="wa-input"
              type="text"
              bind:value={waTestPhone}
              placeholder="5491123456789"
            />
          </label>
          <label class="wa-field">
            <span class="wa-field-label">Message</span>
            <textarea
              class="wa-input wa-textarea"
              bind:value={waTestText}
              rows="3"
              placeholder="hola desde Kernl"
            ></textarea>
          </label>
          <div class="wa-actions">
            <button
              class="act-btn act-primary"
              on:click={sendTestMessage}
              disabled={waTestSending || !waTestPhone || !waTestText}
            >
              {waTestSending ? 'Sending…' : 'Send'}
            </button>
            {#if waTestResult}<span class="wa-save-msg">{waTestResult}</span>{/if}
          </div>
        </section>
      {/if}
    {/if}

    <section class="drawer-section">
      <div class="section-title">Metadata</div>
      <dl class="kv">
        <dt>Author</dt>       <dd>{sel.manifest?.author ?? '—'}</dd>
        <dt>Category</dt>     <dd>{sel.manifest?.category ?? '—'}</dd>
        <dt>Installed</dt>    <dd>{sel.installed_at}</dd>
        <dt>Last loaded</dt>  <dd>{sel.last_loaded_at ?? 'never'}</dd>
        <dt>Install path</dt> <dd class="mono small">{sel.install_path || '—'}</dd>
      </dl>
    </section>

    {#if sel.manifest?.tags?.length}
      <section class="drawer-section">
        <div class="section-title">Tags</div>
        <div class="chip-row">
          {#each sel.manifest.tags as tag}
            <span class="chip chip-static">{tag}</span>
          {/each}
        </div>
      </section>
    {/if}

    {#if sel.manifest?.dependencies?.length}
      <section class="drawer-section">
        <div class="section-title">Depends on</div>
        <div class="chip-row">
          {#each sel.manifest.dependencies as dep}
            {@const depExt = resolveDep(dep)}
            {#if depExt}
              <button
                type="button"
                class="chip chip-dep mono"
                class:chip-dep-missing={false}
                on:click|stopPropagation={() => (selected = depExt)}
                title="Open {depExt.name}"
              >
                {depExt.name}
                <span class="chip-dep-status chip-dep-{depExt.status}"></span>
              </button>
            {:else}
              <span class="chip chip-static mono chip-dep-missing" title="Not installed">
                {dep} <span class="chip-dep-missing-mark">✕</span>
              </span>
            {/if}
          {/each}
        </div>
      </section>
    {/if}

    {#if findDependents(sel).length}
      <section class="drawer-section">
        <div class="section-title">Required by</div>
        <div class="chip-row">
          {#each findDependents(sel) as dep}
            <button
              type="button"
              class="chip chip-dep mono"
              on:click|stopPropagation={() => (selected = dep)}
              title="Open {dep.name}"
            >
              {dep.name}
              <span class="chip-dep-status chip-dep-{dep.status}"></span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if sel.manifest?.permissions?.length}
      <section class="drawer-section">
        <div class="section-title">Permissions granted</div>
        <div class="perms">
          {#each sel.manifest.permissions as perm}
            <span class="perm">{perm}</span>
          {/each}
        </div>
      </section>
    {/if}

    {#if sel.manifest?.integrity?.sha256}
      <section class="drawer-section">
        <div class="section-title">Integrity</div>
        <div class="sha mono">{sel.manifest.integrity.sha256}</div>
      </section>
    {/if}
  </aside>
{/if}

<!-- Install modal (uses existing app.css compose-overlay / compose-modal) -->
{#if showUpload}
  <div class="compose-overlay" role="presentation" on:click|self={() => (showUpload = false)}>
    <div class="compose-modal install-modal" role="dialog" aria-modal="true">
      <h3>Install extension</h3>

      <div class="compose-row">
        <label for="ext-file">Upload .kernl file</label>
        <input
          id="ext-file"
          type="file"
          accept=".kernl,.kernlext,.tar.gz,.tgz"
          on:change={onFilePick}
          class="install-file"
        />
        {#if uploadFile}
          <div class="file-hint">
            Selected: <span class="mono">{uploadFile.name}</span>
            ({Math.round(uploadFile.size / 1024)} KB)
          </div>
        {/if}
      </div>

      <div class="divider-or"><span>or</span></div>

      <div class="compose-row">
        <label for="ext-path">Server path to bundle</label>
        <input
          id="ext-path"
          type="text"
          class="install-input"
          placeholder="/absolute/path/to/extension.kernl"
          bind:value={uploadPath}
        />
      </div>

      {#if uploadError}
        <div class="install-error">{uploadError}</div>
      {/if}

      <div class="compose-actions">
        <button class="compose-btn-cancel" on:click={() => (showUpload = false)}>Cancel</button>
        <button class="compose-btn-send" disabled={uploading} on:click={doUpload}>
          {uploading ? 'Installing…' : 'Install'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  :global(:root) {
    --ext-module:   #5B9BF7;
    /* Aliases the global --skill token so the hub, the per-agent panel in the
       agent drawers and this page's type badge can never drift apart. */
    --ext-skill:    var(--skill);
    --ext-agent:    #D4A84B;
    --ext-flow:     #3DD6C8;
    --ext-theme:    #E85A9B;
    --ext-template: #F59E0B;
    --ext-channel:  #9966FF;
  }

  /* ── Command bar ──────────────────────────────────────────────────
     Replaces the old 190px hero. Title, search and the ＋ menu on one
     48px row: the search field is the widest thing on the page because
     searching is the thing people came to do. */
  .bar {
    display: flex; align-items: center; gap: 14px;
    margin-bottom: 10px;
  }
  .bar-brand { display: flex; align-items: center; gap: 9px; flex: none; }
  .bar-mark {
    font-size: 17px;
    color: var(--ext-module);
  }
  .bar-title {
    font-family: var(--font-display, sans-serif);
    font-size: 19px; font-weight: 700; letter-spacing: -0.01em;
    color: var(--text-1); margin: 0; white-space: nowrap;
  }
  .bar-search {
    position: relative; flex: 1 1 auto; min-width: 0;
    display: flex; align-items: center;
  }
  .bar-search input {
    width: 100%;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 9px;
    padding: 9px 34px 9px 32px;
    font-size: 13px;
    transition: border-color .15s, box-shadow .15s;
  }
  .bar-search input:focus {
    outline: none;
    border-color: var(--ext-module);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ext-module) 15%, transparent);
  }
  .bar-search-icon {
    position: absolute; left: 11px; font-size: 14px;
    color: var(--text-2); pointer-events: none;
  }
  .bar-search-clear {
    position: absolute; right: 8px;
    background: none; border: none; cursor: pointer;
    color: var(--text-2); font-size: 17px; line-height: 1;
    padding: 2px 5px; border-radius: 5px;
  }
  .bar-search-clear:hover { color: var(--text-1); background: var(--surface-3); }

  .bar-plus { position: relative; flex: none; }
  .plus-btn {
    width: 34px; height: 34px;
    display: inline-flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, var(--ext-module), var(--ext-flow));
    color: var(--bg); border: none; border-radius: 9px;
    font-size: 17px; font-weight: 700; cursor: pointer;
    box-shadow: 0 2px 10px color-mix(in srgb, var(--ext-module) 35%, transparent);
    transition: transform .15s;
  }
  .plus-btn:hover { transform: translateY(-1px); }
  .plus-scrim { position: fixed; inset: 0; z-index: 40; }
  .plus-menu {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 41;
    width: 290px; padding: 6px;
    background: var(--surface-1);
    border: 1px solid var(--border-h);
    border-radius: 11px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.4);
    display: flex; flex-direction: column; gap: 2px;
  }
  .plus-menu button {
    display: flex; align-items: flex-start; gap: 10px;
    background: none; border: none; cursor: pointer;
    padding: 9px 10px; border-radius: 8px; text-align: left;
    color: var(--text-1);
  }
  .plus-menu button:hover { background: var(--surface-3); }
  .plus-menu-icon {
    flex: none; width: 24px; height: 24px; margin-top: 1px;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--surface-3); border-radius: 6px;
    font-size: 12px; color: var(--ext-module);
  }
  .plus-menu strong { display: block; font-size: 13px; font-weight: 600; }
  .plus-menu small {
    display: block; font-size: 11.5px; color: var(--text-2); margin-top: 2px;
    line-height: 1.4;
  }
  .plus-menu small code {
    font-family: var(--font-mono, monospace);
    background: var(--surface-3); padding: 0 3px; border-radius: 3px;
  }

  /* ── Tabs + filters ─────────────────────────────────────────────── */
  .tabs {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 8px;
  }
  .tabs-left { display: flex; align-items: center; gap: 2px; }
  .tabs-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tab {
    display: inline-flex; align-items: center; gap: 6px;
    background: none; border: none; cursor: pointer;
    padding: 7px 12px; border-radius: 8px;
    font-size: 13px; font-weight: 600; color: var(--text-2);
    transition: color .15s, background .15s;
  }
  .tab:hover { color: var(--text-1); background: var(--surface-3); }
  .tab-on {
    color: var(--text-1);
    background: color-mix(in srgb, var(--ext-module) 14%, var(--surface-1));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ext-module) 35%, transparent);
  }
  .tab-n {
    font-family: var(--font-mono, monospace);
    font-size: 10.5px; font-weight: 700;
    padding: 1px 5px; border-radius: 20px;
    background: var(--surface-3); color: var(--text-2);
  }
  .tab-n-accent { background: var(--ext-template); color: var(--bg); }
  .tab-accent { color: var(--ext-template); }

  /* Skills tab — carries the skill tint so the tab, the type badge and the
     hub below it are visibly the same subject. */
  .tab-skill { color: var(--ext-skill); }
  .tab-skill.tab-on {
    background: color-mix(in srgb, var(--ext-skill) 14%, var(--surface-1));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ext-skill) 38%, transparent);
    color: var(--ext-skill);
  }
  .tab-n-skill {
    background: color-mix(in srgb, var(--ext-skill) 22%, transparent);
    color: var(--ext-skill);
  }
  /* Type/price/status filters are meaningless inside the skills hub. */
  .tabs-right-hidden { display: none; }

  .typesel { position: relative; }
  .typesel-btn {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--surface-1); border: 1px solid var(--border);
    color: var(--text-2); border-radius: 8px;
    padding: 6px 10px; font-size: 12.5px; cursor: pointer;
  }
  .typesel-btn:hover { color: var(--text-1); border-color: var(--border-h); }
  .typesel-caret { font-size: 9px; opacity: 0.7; }
  .typesel-menu {
    position: absolute; top: calc(100% + 5px); right: 0; z-index: 41;
    min-width: 200px; max-height: 320px; overflow-y: auto; padding: 5px;
    background: var(--surface-1);
    border: 1px solid var(--border-h); border-radius: 10px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.4);
    display: flex; flex-direction: column; gap: 1px;
  }
  .typesel-menu button {
    display: flex; align-items: center; gap: 8px;
    background: none; border: none; cursor: pointer;
    padding: 7px 9px; border-radius: 7px;
    font-size: 12.5px; color: var(--text-2); text-align: left;
  }
  .typesel-menu button:hover { background: var(--surface-3); color: var(--text-1); }
  .typesel-on { background: var(--surface-3); color: var(--text-1) !important; font-weight: 600; }
  .typesel-glyph { width: 14px; text-align: center; }
  .typesel-n {
    margin-left: auto; font-family: var(--font-mono, monospace);
    font-size: 10.5px; color: var(--text-2);
  }

  .seg {
    display: inline-flex; padding: 2px;
    background: var(--surface-1);
    border: 1px solid var(--border); border-radius: 8px;
  }
  .seg button {
    background: none; border: none; cursor: pointer;
    padding: 4px 11px; border-radius: 6px;
    font-size: 12px; color: var(--text-2);
    transition: color .15s, background .15s;
  }
  .seg button:hover { color: var(--text-1); }
  .seg-on {
    background: var(--surface-3); color: var(--text-1) !important; font-weight: 600;
  }

  /* One-line alerts, only rendered when they carry information. */
  .thin-alert {
    display: block; width: 100%; text-align: left;
    background: color-mix(in srgb, var(--gold) 10%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--gold) 35%, var(--border));
    color: var(--text-2);
    border-radius: 8px; padding: 8px 12px; margin-bottom: 12px;
    font-size: 12.5px; cursor: default;
  }
  .thin-alert-red {
    background: color-mix(in srgb, var(--red) 10%, var(--surface-1));
    border-color: color-mix(in srgb, var(--red) 35%, var(--border));
    cursor: pointer;
  }
  .thin-alert-red:hover { border-color: var(--red); }

  /* ── Section headers ─────────────────────────────────────────────
     A hairline rule + a small caps label. Cheap, and it gives the page a
     spine so "Premium" and "Free" read as different shelves rather than one
     undifferentiated wall of cards. */
  .sec-head {
    display: flex; align-items: center; gap: 10px;
    margin: 4px 0 12px;
  }
  .sec-rule {
    width: 3px; height: 15px; border-radius: 2px;
    background: linear-gradient(180deg, var(--gold), color-mix(in srgb, var(--gold) 20%, transparent));
  }
  .sec-title {
    font-family: var(--font-display, sans-serif);
    font-size: 12px; font-weight: 700; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--text-2); margin: 0;
  }
  /* --text-3 (#4A4F6A) only reaches 2.25:1 on these surfaces, so anything
     carrying actual information here uses --text-2 (5.95:1). --text-3 stays
     for purely decorative or redundant marks. */
  .sec-n {
    font-family: var(--font-mono, monospace);
    font-size: 10.5px; font-weight: 700; color: var(--text-2);
    background: var(--surface-3); padding: 1px 6px; border-radius: 20px;
  }
  .sec-note { font-size: 11.5px; color: var(--gold); }
  .sec-link {
    margin-left: auto;
    background: none; border: none; cursor: pointer;
    font-size: 11.5px; color: var(--text-2);
  }
  .sec-link:hover { color: var(--ext-module); text-decoration: underline; }

  /* ── All-Access strip ────────────────────────────────────────────
     The only gradient on the page, deliberately: it marks the one offer that
     covers everything. Shown only when the user doesn't already have it. */
  .aa {
    position: relative; overflow: hidden;
    display: flex; align-items: center; justify-content: space-between;
    gap: 24px; flex-wrap: wrap;
    padding: 18px 22px; margin-bottom: 18px;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--gold) 28%, var(--border));
    background:
      linear-gradient(112deg,
        color-mix(in srgb, var(--gold) 13%, transparent) 0%,
        color-mix(in srgb, var(--ext-theme) 8%, transparent) 46%,
        transparent 78%),
      var(--surface-1);
  }
  .aa-glow {
    position: absolute; inset: -60% 55% -60% -10%;
    background: radial-gradient(ellipse at center, color-mix(in srgb, var(--gold) 16%, transparent), transparent 70%);
    pointer-events: none;
  }
  .aa-body { position: relative; z-index: 1; max-width: 560px; }
  .aa-kicker {
    font-family: var(--font-mono, monospace);
    font-size: 10px; font-weight: 700; letter-spacing: 0.2em;
    text-transform: uppercase; color: var(--gold);
  }
  .aa-title {
    font-family: var(--font-display, sans-serif);
    font-size: 20px; font-weight: 700; letter-spacing: -0.01em;
    color: var(--text-1); margin: 5px 0 6px; line-height: 1.2;
  }
  .aa-sub { font-size: 12.5px; line-height: 1.55; color: var(--text-2); margin: 0; }

  .aa-buy { position: relative; z-index: 1; text-align: right; flex: none; }
  .aa-price {
    display: flex; align-items: baseline; justify-content: flex-end; gap: 2px;
    font-family: var(--font-display, sans-serif);
    color: var(--text-1);
    /* Tabular figures so prices don't jiggle between cards. */
    font-variant-numeric: tabular-nums;
  }
  .aa-price-sym { font-size: 15px; font-weight: 600; color: var(--gold); }
  .aa-price-num { font-size: 34px; font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
  .aa-price-per { font-size: 12px; color: var(--text-2); margin-left: 2px; }
  .aa-alt { font-size: 11.5px; color: var(--text-2); margin-top: 3px; }
  .aa-cta {
    display: inline-block; margin-top: 10px;
    background: linear-gradient(135deg, var(--gold), color-mix(in srgb, var(--gold) 62%, var(--ext-template)));
    color: var(--bg); text-decoration: none;
    border-radius: 9px; padding: 9px 20px;
    font-family: var(--font-display, sans-serif);
    font-size: 13px; font-weight: 700;
    box-shadow: 0 3px 16px color-mix(in srgb, var(--gold) 32%, transparent);
    transition: transform .2s, box-shadow .2s;
  }
  .aa-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 24px color-mix(in srgb, var(--gold) 45%, transparent);
  }

  /* ── Storefront cards ────────────────────────────────────────────
     Bigger than the utility grid, with the price as the second-loudest thing
     after the name. Everything here exists to answer "what is it, what does
     it cost, is it mine". */
  .shelf { margin-bottom: 26px; }
  .shelf-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 14px;
  }
  .pcard {
    position: relative; overflow: hidden;
    display: flex; flex-direction: column;
    padding: 16px 17px 14px;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--gold) 22%, var(--border));
    background:
      linear-gradient(168deg, color-mix(in srgb, var(--gold) 7%, transparent), transparent 55%),
      var(--surface-1);
    transition: transform .2s, border-color .2s, box-shadow .25s;
    animation: pcard-in .4s cubic-bezier(.22,.68,0,1) backwards;
    animation-delay: var(--stagger, 0ms);
  }
  .pcard-owned {
    border-color: color-mix(in srgb, var(--green) 30%, var(--border));
    background:
      linear-gradient(168deg, color-mix(in srgb, var(--green) 7%, transparent), transparent 55%),
      var(--surface-1);
  }
  .pcard:hover {
    transform: translateY(-3px);
    border-color: color-mix(in srgb, var(--gold) 55%, transparent);
    box-shadow:
      0 16px 44px color-mix(in srgb, var(--gold) 14%, transparent),
      0 2px 0 color-mix(in srgb, var(--gold) 20%, transparent) inset;
  }
  .pcard-owned:hover {
    border-color: color-mix(in srgb, var(--green) 55%, transparent);
    box-shadow: 0 16px 44px color-mix(in srgb, var(--green) 14%, transparent);
  }

  /* A single diagonal sheen that sweeps once on hover. One high-impact
     moment beats five fidgety micro-animations. */
  .pcard-sheen {
    position: absolute; top: 0; bottom: 0; width: 45%;
    left: -60%;
    background: linear-gradient(100deg, transparent, rgba(255,255,255,0.05), transparent);
    pointer-events: none;
    transition: left .55s cubic-bezier(.3,.7,0,1);
  }
  .pcard:hover .pcard-sheen { left: 130%; }

  .pcard-body {
    background: none; border: none; padding: 0; margin: 0;
    font: inherit; color: inherit; text-align: left; cursor: pointer;
    flex: 1 1 auto;
  }
  .pcard-body:focus-visible {
    outline: 2px solid var(--gold); outline-offset: 3px; border-radius: 8px;
  }

  .pcard-top {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; margin-bottom: 11px;
  }
  .pcard-mark {
    width: 46px; height: 46px; flex: none;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 24px; line-height: 1;
    border-radius: 12px;
    background: color-mix(in srgb, var(--gold) 10%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--gold) 24%, transparent);
  }
  .pcard-owned .pcard-mark {
    background: color-mix(in srgb, var(--green) 10%, var(--surface-2));
    border-color: color-mix(in srgb, var(--green) 24%, transparent);
  }
  .pcard-price {
    display: flex; align-items: baseline; gap: 1px;
    font-family: var(--font-display, sans-serif);
    color: var(--text-1);
    font-variant-numeric: tabular-nums;
  }
  .pcard-price-sym { font-size: 13px; font-weight: 600; color: var(--gold); }
  .pcard-price-num {
    font-size: 27px; font-weight: 700; line-height: 1; letter-spacing: -0.02em;
  }
  .pcard-owned-tag {
    font-family: var(--font-mono, monospace);
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;
    color: var(--green);
    background: color-mix(in srgb, var(--green) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--green) 32%, transparent);
    padding: 4px 8px; border-radius: 6px; white-space: nowrap;
  }

  .pcard-name {
    font-family: var(--font-display, sans-serif);
    font-size: 16.5px; font-weight: 700; letter-spacing: -0.01em;
    color: var(--text-1); margin: 0; line-height: 1.25;
  }
  .pcard-meta {
    font-size: 11.5px; color: var(--text-2); margin-top: 3px;
    font-variant-numeric: tabular-nums;
  }
  .pcard-desc {
    font-size: 12.5px; line-height: 1.55; color: var(--text-2);
    margin: 9px 0 11px;
    display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3;
    -webkit-box-orient: vertical; overflow: hidden;
  }
  .pcard-trust { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .trust {
    font-size: 11px; color: var(--text-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    padding: 3px 8px; border-radius: 20px;
    white-space: nowrap;
  }

  .pcard-foot { margin-top: auto; }
  .pcard-cta {
    width: 100%;
    background: linear-gradient(135deg, var(--gold), color-mix(in srgb, var(--gold) 62%, var(--ext-template)));
    color: var(--bg); border: none;
    border-radius: 9px; padding: 10px 14px;
    font-family: var(--font-display, sans-serif);
    font-size: 13.5px; font-weight: 700; cursor: pointer;
    box-shadow: 0 2px 12px color-mix(in srgb, var(--gold) 26%, transparent);
    transition: transform .18s, box-shadow .18s, filter .18s;
  }
  .pcard-cta:hover:not(:disabled) {
    transform: translateY(-1px); filter: brightness(1.07);
    box-shadow: 0 5px 20px color-mix(in srgb, var(--gold) 40%, transparent);
  }
  .pcard-cta:disabled { opacity: 0.65; cursor: default; box-shadow: none; }
  .pcard-cta-owned {
    background: linear-gradient(135deg, var(--green), color-mix(in srgb, var(--green) 65%, var(--ext-flow)));
    box-shadow: 0 2px 12px color-mix(in srgb, var(--green) 26%, transparent);
  }
  .pcard-cta-owned:hover:not(:disabled) {
    box-shadow: 0 5px 20px color-mix(in srgb, var(--green) 40%, transparent);
  }
  .pcard-hint {
    margin-top: 9px; font-size: 11px; line-height: 1.45;
    color: var(--gold);
    background: color-mix(in srgb, var(--gold) 8%, transparent);
    border-left: 2px solid var(--gold);
    padding: 7px 9px; border-radius: 6px;
  }

  @keyframes pcard-in {
    from { opacity: 0; transform: translateY(10px) scale(0.985); }
    to   { opacity: 1; transform: none; }
  }

  /* Motion is decoration here, not information — drop all of it on request. */
  @media (prefers-reduced-motion: reduce) {
    .pcard { animation: none; transition: border-color .2s; }
    .pcard:hover { transform: none; }
    .pcard-sheen { display: none; }
    .pcard-cta:hover:not(:disabled),
    .aa-cta:hover { transform: none; }
  }

  .btn-install {
    display: inline-flex; align-items: center; gap: 10px;
    background: linear-gradient(135deg, var(--ext-module), var(--ext-flow));
    color: var(--bg);
    border: none; border-radius: 10px;
    padding: 12px 22px;
    font-family: var(--font-display, sans-serif);
    font-size: 14px; font-weight: 700; letter-spacing: 0.02em;
    cursor: pointer;
    box-shadow:
      0 4px 20px color-mix(in srgb, var(--ext-module) 40%, transparent),
      inset 0 1px 0 rgba(255,255,255,0.25);
    transition: transform .15s, box-shadow .15s;
  }
  .btn-install:hover {
    transform: translateY(-1px);
    box-shadow:
      0 6px 28px color-mix(in srgb, var(--ext-module) 55%, transparent),
      inset 0 1px 0 rgba(255,255,255,0.35);
  }
  .btn-install-icon {
    display: inline-flex; width: 20px; height: 20px;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 13px;
  }

  .chip-static {
    cursor: default; pointer-events: none;
  }
  .chip-dep {
    background: transparent;
    border-color: color-mix(in srgb, var(--card-tint) 40%, var(--border));
    color: var(--text-1);
  }
  .chip-dep:hover {
    background: color-mix(in srgb, var(--card-tint) 12%, var(--surface-1));
    border-color: color-mix(in srgb, var(--card-tint) 65%, var(--border-h));
  }
  .chip-dep-status {
    width: 6px; height: 6px; border-radius: 999px; display: inline-block;
    background: var(--text-3);
  }
  .chip-dep-active    { background: var(--green); }
  .chip-dep-installed { background: var(--gold); }
  .chip-dep-disabled  { background: var(--text-3); }
  .chip-dep-error     { background: var(--red); }
  .chip-dep-missing {
    border-color: color-mix(in srgb, var(--red) 45%, var(--border));
    color: color-mix(in srgb, var(--red) 70%, var(--text-2));
  }
  .chip-dep-missing-mark {
    color: var(--red); margin-left: 2px;
  }

  /* ── Grid ─────────────────────────────────────────────────────── */
  .grid {
    display: grid;
    /* Denser than the old 340px: four columns on a 1700px screen instead of
       four wide ones, so a browse is a browse and not a scroll. */
    grid-template-columns: repeat(auto-fill, minmax(272px, 1fr));
    gap: 12px;
  }
  .card {
    position: relative;
    display: flex; flex-direction: column;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 15px 12px;
    transition: transform .15s, border-color .15s, box-shadow .2s;
    overflow: hidden;
    text-align: left;
    font: inherit;
  }
  .card:hover {
    transform: translateY(-2px);
    border-color: color-mix(in srgb, var(--card-tint) 50%, var(--border-h));
    box-shadow: 0 12px 40px color-mix(in srgb, var(--card-tint) 12%, transparent);
  }
  .card-disabled { opacity: 0.55; }
  .card-error { border-color: color-mix(in srgb, var(--red) 45%, var(--border)); }
  .card-paid { border-color: color-mix(in srgb, var(--gold) 28%, var(--border)); }

  /* The whole body is the "open detail" hit area; the action button lives
     outside it so one click can install without opening anything. */
  .card-body {
    display: block; width: 100%;
    background: none; border: none; padding: 0; margin: 0;
    font: inherit; color: inherit; text-align: left; cursor: pointer;
    flex: 1 1 auto;
  }
  .card-body:focus-visible {
    outline: 2px solid var(--card-tint);
    outline-offset: 3px; border-radius: 6px;
  }

  .card-stripe {
    position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg,
      var(--card-tint),
      color-mix(in srgb, var(--card-tint) 20%, transparent));
  }

  .card-head {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 10px; align-items: start;
    margin-bottom: 9px;
  }
  .card-icon {
    width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--card-tint) 12%, var(--surface-2));
    color: var(--card-tint);
    border: 1px solid color-mix(in srgb, var(--card-tint) 30%, transparent);
    border-radius: 10px;
    font-size: 20px; font-weight: 600;
    flex-shrink: 0;
    overflow: hidden;
  }
  .card-icon-img {
    width: 28px; height: 28px;
    object-fit: contain;
    display: block;
  }
  .card-head-text { min-width: 0; }
  .card-name {
    font-family: var(--font-display, sans-serif);
    font-size: 15.5px; font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-1); line-height: 1.3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .card-sub {
    font-size: 11.5px; color: var(--text-2);
    display: flex; gap: 6px; align-items: center; margin-top: 3px;
  }
  .card-sub .sep { opacity: 0.5; }
  .card-from { color: var(--ext-template); }
  .card-price {
    font-family: var(--font-mono, monospace);
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--gold);
    background: color-mix(in srgb, var(--gold) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--gold) 30%, transparent);
    padding: 3px 8px; border-radius: 6px;
    white-space: nowrap; align-self: flex-start;
  }

  /* Price (or ✓ Owned) on paid cards. */
  .card-badge {
    font-family: var(--font-mono, monospace);
    font-size: 11.5px; font-weight: 700;
    color: var(--gold);
    background: color-mix(in srgb, var(--gold) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--gold) 32%, transparent);
    padding: 3px 7px; border-radius: 6px;
    white-space: nowrap; align-self: flex-start;
  }
  .card-badge-owned {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 12%, transparent);
    border-color: color-mix(in srgb, var(--green) 32%, transparent);
  }

  /* Installed state as a dot instead of a shouty uppercase tag — the status of
     something you already installed is ambient information, not a headline. */
  .card-dot {
    width: 7px; height: 7px; border-radius: 50%;
    align-self: center; flex: none;
  }
  .card-dot-active    { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .card-dot-installed { background: var(--gold); }
  .card-dot-disabled  { background: var(--text-3); }
  .card-dot-error     { background: var(--red); box-shadow: 0 0 8px var(--red); }

  .card-locked {
    display: flex; align-items: flex-start; gap: 7px;
    margin: 0 12px 10px; padding: 8px 10px;
    border: 1px solid rgba(240, 180, 41, 0.32);
    border-radius: 6px;
    background: rgba(240, 180, 41, 0.07);
    color: var(--gold);
    font-size: 11.5px; line-height: 1.45;
    text-decoration: none;
  }
  .card-locked:hover { border-color: rgba(240, 180, 41, 0.6); }
  .card-locked code {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    padding: 0 3px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.25);
  }
  .card-locked-icon { flex: none; }

  .card-desc {
    font-size: 12px; line-height: 1.5; color: var(--text-2);
    margin: 0 0 10px; display: -webkit-box;
    -webkit-line-clamp: 2; line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden;
  }

  .card-foot {
    display: flex; align-items: center; gap: 8px;
    margin-top: auto;
  }
  .card-act {
    flex: 1 1 auto;
    background: color-mix(in srgb, var(--card-tint) 16%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--card-tint) 40%, var(--border));
    color: var(--text-1);
    border-radius: 8px; padding: 7px 12px;
    font-size: 12.5px; font-weight: 600; cursor: pointer;
    transition: background .15s, border-color .15s, transform .12s;
  }
  .card-act:hover:not(:disabled) {
    background: color-mix(in srgb, var(--card-tint) 26%, var(--surface-2));
    transform: translateY(-1px);
  }
  .card-act:disabled { opacity: 0.6; cursor: default; }
  .card-act-buy {
    background: linear-gradient(135deg, var(--gold), color-mix(in srgb, var(--gold) 70%, var(--ext-template)));
    border-color: transparent; color: var(--bg); font-weight: 700;
  }
  .card-act-update {
    background: color-mix(in srgb, var(--ext-template) 22%, var(--surface-2));
    border-color: color-mix(in srgb, var(--ext-template) 50%, var(--border));
  }
  .card-act-ghost {
    background: none; color: var(--text-2);
    border-color: var(--border);
  }
  .card-act-ghost:hover:not(:disabled) { color: var(--text-1); border-color: var(--border-h); background: var(--surface-3); }
  .card-aa {
    font-size: 11.5px; color: var(--text-2); text-decoration: none;
    white-space: nowrap;
  }
  .card-aa:hover { color: var(--ext-module); text-decoration: underline; }

  .card-author {
    margin-left: auto; font-size: 11px; color: var(--text-2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 120px;
  }

  .card-error-msg {
    margin-top: 10px;
    font-size: 11px; color: var(--red); line-height: 1.4;
    background: color-mix(in srgb, var(--red) 8%, transparent);
    padding: 8px 10px; border-radius: 6px;
    border-left: 2px solid var(--red);
  }

  /* ── Tags ─────────────────────────────────────────────────────── */
  .tag {
    display: inline-flex; align-items: center;
    font-family: var(--font-mono, monospace);
    font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
    padding: 3px 8px; border-radius: 4px;
    background: var(--surface-3); color: var(--text-2);
    border: 1px solid var(--border);
    text-transform: uppercase;
  }
  .tag-type {
    background: color-mix(in srgb, var(--card-tint) 14%, var(--surface-2));
    color: var(--card-tint);
    border-color: color-mix(in srgb, var(--card-tint) 35%, transparent);
  }
  .tag-status-active {
    background: color-mix(in srgb, var(--green) 14%, var(--surface-2));
    color: var(--green);
    border-color: color-mix(in srgb, var(--green) 35%, transparent);
  }
  .tag-status-error {
    background: color-mix(in srgb, var(--red) 14%, var(--surface-2));
    color: var(--red);
    border-color: color-mix(in srgb, var(--red) 35%, transparent);
  }
  .tag-status-disabled { opacity: 0.6; }
  .tag-muted { color: var(--text-3); }
  .tag-price {
    background: color-mix(in srgb, var(--gold) 14%, var(--surface-2));
    color: var(--gold);
    border-color: color-mix(in srgb, var(--gold) 35%, transparent);
  }

  /* ── States ───────────────────────────────────────────────────── */
  .loading {
    padding: 60px; text-align: center; color: var(--text-3);
    font-size: 13px; letter-spacing: 0.05em;
  }
  .error-banner {
    padding: 14px 18px; background: color-mix(in srgb, var(--red) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
    color: var(--red); border-radius: 10px; font-size: 13px;
  }
  .empty {
    padding: 56px 32px; text-align: center;
    background: var(--surface-1);
    border: 1px dashed var(--border-h); border-radius: 14px;
  }
  .empty-icon {
    font-size: 40px; color: var(--ext-flow); margin-bottom: 10px; opacity: 0.8;
  }
  .empty-title {
    font-family: var(--font-display, sans-serif);
    font-size: 18px; font-weight: 700; color: var(--text-1);
    margin-bottom: 6px;
  }
  .empty-sub {
    font-size: 13px; color: var(--text-2); max-width: 440px;
    margin: 0 auto 18px; line-height: 1.6;
  }
  .empty-sub code {
    font-family: var(--font-mono, monospace);
    background: var(--surface-3); padding: 1px 5px; border-radius: 4px;
    font-size: 12px; color: var(--ext-flow);
  }
  .empty-actions {
    display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;
  }
  .empty-actions .btn-install { padding: 9px 16px; font-size: 13px; }

  .repos-close {
    margin-left: auto;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); font-size: 18px; line-height: 1;
    padding: 2px 6px; border-radius: 6px;
  }
  .repos-close:hover { color: var(--text-1); background: var(--surface-3); }

  .drawer-note {
    font-size: 12.5px; line-height: 1.6; color: var(--text-2); margin: 0;
  }
  .perm-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag-perm {
    text-transform: none; letter-spacing: 0;
    color: var(--ext-flow);
    background: color-mix(in srgb, var(--ext-flow) 10%, var(--surface-2));
    border-color: color-mix(in srgb, var(--ext-flow) 28%, transparent);
  }

  /* ── Drawer ───────────────────────────────────────────────────── */
  .drawer-scrim {
    position: fixed; inset: 0; z-index: 300;
    background: rgba(7,8,12,0.6);
    backdrop-filter: blur(4px);
    animation: fade .18s;
  }
  .drawer {
    position: fixed; top: 0; right: 0; bottom: 0;
    width: 520px; max-width: 92vw;
    background: var(--surface-1);
    border-left: 1px solid var(--border-h);
    padding: 24px 28px;
    overflow-y: auto;
    z-index: 400;
    box-shadow: -12px 0 40px rgba(0,0,0,0.5);
    animation: slide-in .22s cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  /* Wider drawer for extensions that embed rich grids (claude-code with its
     skills/plugins/MCPs grid needs room to breathe). */
  .drawer-wide { width: 1180px; max-width: 96vw; }

  .cc-panel { padding: 0; margin-top: 18px; }

  /* LLM provider config form */
  .llm-panel { margin-top: 14px; }
  .llm-form { display: flex; flex-direction: column; gap: 14px; }
  .llm-field { display: flex; flex-direction: column; gap: 6px; }
  .llm-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    letter-spacing: 0.02em;
  }
  .llm-req { color: var(--red); margin-left: 2px; }
  .llm-row { display: flex; gap: 6px; align-items: stretch; }
  .llm-row .llm-input { flex: 1; }
  .llm-input {
    background: var(--bg-2);
    border: 1px solid var(--border-1);
    border-radius: 6px;
    color: var(--text-1);
    padding: 8px 10px;
    font: inherit;
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    width: 100%;
  }
  .llm-input:focus { outline: none; border-color: var(--card-tint); }
  .llm-textarea { min-height: 70px; resize: vertical; font-family: var(--font-mono, monospace); }
  .llm-btn-mini {
    background: var(--bg-2);
    border: 1px solid var(--border-1);
    border-radius: 6px;
    color: var(--text-2);
    padding: 0 10px;
    font-size: 14px;
    cursor: pointer;
  }
  .llm-btn-mini:hover { color: var(--text-1); border-color: var(--card-tint); }
  .llm-btn-mini:disabled { opacity: 0.4; cursor: default; }
  .llm-help { font-size: 11px; color: var(--text-3); }
  .llm-hint { font-size: 12px; color: var(--text-3); padding: 8px 0; }
  .llm-actions { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
  .llm-msg { font-size: 12px; color: var(--text-2); }

  .drawer-ribbon {
    position: absolute; top: 0; left: 0; right: 0; height: 4px;
    background: linear-gradient(90deg,
      var(--card-tint),
      color-mix(in srgb, var(--card-tint) 30%, transparent));
  }

  .drawer-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 12px; margin-bottom: 16px; padding-top: 8px;
  }
  .drawer-title {
    display: flex; gap: 14px; align-items: flex-start; min-width: 0; flex: 1;
  }
  .drawer-icon {
    width: 54px; height: 54px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--card-tint) 14%, var(--surface-2));
    color: var(--card-tint);
    border: 1px solid color-mix(in srgb, var(--card-tint) 35%, transparent);
    border-radius: 12px;
    font-size: 26px;
    overflow: hidden;
  }
  .drawer-icon-img {
    width: 36px; height: 36px;
    object-fit: contain;
    display: block;
  }
  .drawer-name {
    font-family: var(--font-display, sans-serif);
    font-size: 22px; font-weight: 700; color: var(--text-1);
    line-height: 1.15; margin-bottom: 4px;
    word-break: break-word;
  }
  .drawer-id {
    font-size: 11px; color: var(--text-3); word-break: break-all;
  }
  .drawer-close {
    background: none; border: 1px solid var(--border);
    color: var(--text-2); border-radius: 8px;
    width: 32px; height: 32px; font-size: 18px; line-height: 1;
    cursor: pointer; flex-shrink: 0;
    transition: all .12s;
  }
  .drawer-close:hover { color: var(--text-1); border-color: var(--border-h); background: var(--surface-2); }

  .drawer-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 16px; }
  .drawer-desc {
    font-size: 13.5px; line-height: 1.6; color: var(--text-2);
    margin: 0 0 22px; padding: 14px 16px;
    background: var(--surface-2);
    border-left: 2px solid var(--card-tint);
    border-radius: 0 8px 8px 0;
  }

  .drawer-actions {
    display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap;
  }
  .act-btn {
    padding: 9px 18px; border-radius: 8px;
    font-family: var(--font-display, sans-serif);
    font-size: 12px; font-weight: 700; letter-spacing: 0.05em;
    cursor: pointer; border: 1px solid transparent;
    transition: all .12s; text-transform: uppercase;
  }
  .act-primary {
    background: var(--green); color: var(--bg);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 40%, transparent);
  }
  .act-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 18px color-mix(in srgb, var(--green) 45%, transparent);
  }
  .act-secondary {
    background: var(--surface-2); color: var(--text-1); border-color: var(--border-h);
  }
  .act-secondary:hover { background: var(--surface-3); }
  .act-danger {
    background: transparent; color: var(--red);
    border-color: color-mix(in srgb, var(--red) 50%, transparent);
  }
  .act-danger:hover {
    background: color-mix(in srgb, var(--red) 12%, transparent);
    border-color: var(--red);
  }

  .drawer-section { margin-bottom: 22px; }
  .section-title {
    font-family: var(--font-mono, monospace);
    font-size: 11px; letter-spacing: 0.18em; font-weight: 600;
    color: var(--text-3); text-transform: uppercase; margin-bottom: 10px;
  }

  .kv {
    display: grid; grid-template-columns: 110px 1fr; gap: 8px 14px;
    font-size: 12.5px; margin: 0;
  }
  .kv dt { color: var(--text-3); }
  .kv dd { color: var(--text-1); margin: 0; word-break: break-word; }

  .perms { display: flex; flex-wrap: wrap; gap: 4px; }
  .perm {
    font-family: var(--font-mono, monospace);
    font-size: 11px; padding: 3px 8px; border-radius: 4px;
    background: var(--surface-2); color: var(--text-2);
    border: 1px solid var(--border);
  }

  .sha {
    font-size: 10.5px; color: var(--text-3);
    background: var(--surface-2); padding: 10px 12px;
    border-radius: 6px; word-break: break-all;
    border: 1px solid var(--border);
  }

  /* ── Install modal ────────────────────────────────────────────── */
  .install-modal h3 {
    background: linear-gradient(135deg, var(--ext-module), var(--ext-flow));
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .install-file, .install-input {
    width: 100%;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); border-radius: 8px;
    padding: 8px 12px; font-size: 13px;
  }
  .install-file { padding: 6px; }
  .install-input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--ext-module) 60%, var(--border));
  }
  .file-hint {
    margin-top: 6px; font-size: 11px; color: var(--text-3);
  }
  .divider-or {
    display: flex; align-items: center; gap: 12px;
    color: var(--text-3); font-size: 11px; letter-spacing: 0.2em;
    text-transform: uppercase; margin: 12px 0;
  }
  .divider-or::before, .divider-or::after {
    content: ''; flex: 1; height: 1px; background: var(--border);
  }
  .install-error {
    padding: 10px 12px; border-radius: 8px;
    background: color-mix(in srgb, var(--red) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--red) 35%, transparent);
    color: var(--red); font-size: 12px; margin-top: 10px;
  }

  /* ── Shared ───────────────────────────────────────────────────── */
  .mono { font-family: var(--font-mono, monospace); }
  .small { font-size: 11px; }

  .anim    { animation: rise .4s .05s both cubic-bezier(0.2, 0.9, 0.3, 1); }
  .anim.d1 { animation-delay: .12s; }
  .anim.d2 { animation-delay: .18s; }
  .anim.d3 { animation-delay: .24s; }

  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes fade {
    from { opacity: 0; } to { opacity: 1; }
  }
  @keyframes slide-in {
    from { transform: translateX(100%); }
    to   { transform: translateX(0); }
  }

  /* ── WhatsApp pairing panel ─────────────────────────────────────── */
  .wa-panel .section-title::before {
    content: "📱 "; filter: grayscale(1);
  }
  .wa-hint {
    font-size: 12px; color: var(--text-3); padding: 14px;
    background: var(--surface-2); border-radius: 8px;
  }
  .wa-qr-wrap {
    display: flex; justify-content: center; padding: 18px 0;
    background:
      radial-gradient(circle at 50% 50%,
        color-mix(in srgb, var(--ext-skill) 10%, transparent) 0%,
        transparent 65%),
      var(--surface-2);
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--ext-skill) 25%, var(--border));
    position: relative;
    overflow: hidden;
  }
  .wa-qr-wrap::before, .wa-qr-wrap::after {
    content: ""; position: absolute; width: 28px; height: 28px;
    border: 2px solid var(--ext-skill);
  }
  .wa-qr-wrap::before {
    top: 10px; left: 10px;
    border-right: none; border-bottom: none; border-top-left-radius: 6px;
  }
  .wa-qr-wrap::after {
    bottom: 10px; right: 10px;
    border-left: none; border-top: none; border-bottom-right-radius: 6px;
  }
  .wa-qr {
    width: 240px; height: 240px; display: block;
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    background: #fff; padding: 6px;
  }
  .wa-steps {
    margin: 14px 0 16px; padding-left: 22px;
    font-size: 12.5px; line-height: 1.75; color: var(--text-2);
  }
  .wa-steps li::marker {
    color: var(--ext-skill); font-weight: 700;
  }
  .wa-steps b { color: var(--text-1); }

  .wa-card {
    display: flex; gap: 14px; align-items: center;
    padding: 14px 16px; border-radius: 10px;
    background: var(--surface-2); border: 1px solid var(--border);
    margin-bottom: 12px;
  }
  .wa-card-ok {
    background: color-mix(in srgb, var(--ext-skill) 10%, var(--surface-2));
    border-color: color-mix(in srgb, var(--ext-skill) 45%, var(--border));
  }
  .wa-card-err {
    background: color-mix(in srgb, var(--red) 10%, var(--surface-2));
    border-color: color-mix(in srgb, var(--red) 45%, var(--border));
  }
  .wa-dot {
    width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
    background: var(--ext-skill);
    box-shadow: 0 0 12px color-mix(in srgb, var(--ext-skill) 70%, transparent);
    animation: pulse 1.8s infinite;
  }
  .wa-dot.err { background: var(--red); box-shadow: 0 0 12px color-mix(in srgb, var(--red) 70%, transparent); }
  .wa-dot.pending { background: var(--gold); box-shadow: 0 0 12px color-mix(in srgb, var(--gold) 70%, transparent); }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .5; }
  }
  .wa-title {
    font-family: var(--font-display, sans-serif);
    font-weight: 700; font-size: 14px; color: var(--text-1);
  }
  .wa-sub { font-size: 12px; color: var(--text-3); }
  .wa-actions {
    display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  }

  /* Config form */
  .wa-field {
    display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;
  }
  .wa-field-label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--text-3);
  }
  .wa-field-hint {
    font-size: 11px; color: var(--text-3); line-height: 1.55;
  }
  .wa-field-hint code {
    background: var(--surface-3); padding: 1px 5px; border-radius: 4px;
    font-family: var(--font-mono, monospace); font-size: 10.5px;
    color: var(--ext-flow);
  }
  .wa-input {
    width: 100%; background: var(--surface-2); color: var(--text-1);
    border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 12px; font-size: 13px;
    font-family: var(--font-mono, monospace);
    transition: border-color .12s;
  }
  .wa-input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--ext-skill) 60%, var(--border));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ext-skill) 18%, transparent);
  }
  .wa-textarea { resize: vertical; min-height: 70px; line-height: 1.5; }
  .wa-save-msg {
    font-size: 12px; color: var(--text-2); font-family: var(--font-mono, monospace);
  }

  .wa-badge-count {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--ext-skill); color: var(--bg);
    border-radius: 999px; padding: 1px 8px;
    font-size: 10px; font-weight: 700; margin-left: 6px;
    font-family: var(--font-mono, monospace);
  }

  .wa-empty {
    font-size: 12px; color: var(--text-3); line-height: 1.55;
    padding: 12px 14px; background: var(--surface-2);
    border: 1px dashed var(--border); border-radius: 8px;
  }

  /* Pending pair rows */
  .wa-pair-list { display: flex; flex-direction: column; gap: 8px; }
  .wa-pair-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 14px; align-items: center;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--gold) 8%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--gold) 30%, var(--border));
    border-radius: 10px;
  }
  .wa-pair-code {
    font-family: var(--font-mono, monospace);
    font-size: 18px; font-weight: 700; color: var(--gold);
    letter-spacing: 0.1em;
    padding: 4px 10px;
    background: var(--surface-1);
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--gold) 40%, transparent);
  }
  .wa-pair-user { min-width: 0; }
  .wa-pair-user-id {
    font-size: 12px; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .wa-pair-user-exp { font-size: 10.5px; color: var(--text-3); margin-top: 2px; }
  .wa-pair-approve { padding: 7px 14px; }

  /* Approved rows */
  .wa-approved-list { display: flex; flex-direction: column; gap: 6px; }
  .wa-approved-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 8px; font-size: 12.5px;
  }
  .wa-approved-row .mono { color: var(--text-1); }
  .wa-revoke {
    padding: 5px 12px; font-size: 10.5px;
  }

  /* ── Activation banner (requires_activation manifests) ──────────── */
  .activation-banner {
    margin: 12px 0 4px;
    padding: 12px 14px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--purple) 14%, var(--surface-2)), var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--purple) 35%, var(--border));
    border-radius: 12px;
    display: flex; gap: 12px; align-items: flex-start;
    font-size: 12.5px; line-height: 1.55;
  }
  .activation-icon {
    font-size: 18px; color: var(--purple); line-height: 1; margin-top: 1px;
  }
  .activation-text strong { color: var(--text-1); display: block; margin-bottom: 3px; }
  .activation-text em { color: var(--purple); font-style: normal; font-weight: 600; }
  .act-btn.act-activate {
    background: linear-gradient(135deg, var(--purple), color-mix(in srgb, var(--purple) 70%, var(--gold)));
    color: var(--bg);
  }

  /* ── Install Receipt panel ──────────────────────────────────────── */
  .receipt-panel {
    margin-top: 16px;
    padding: 14px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .receipt-panel .section-title {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-2); margin-bottom: 10px;
  }
  .receipt-badge {
    font-size: 10px; font-weight: 600; letter-spacing: 0.05em;
    padding: 2px 7px; border-radius: 999px;
    border: 1px solid currentColor;
    text-transform: uppercase;
  }
  .receipt-badge-ok   { color: var(--green); }
  .receipt-badge-warn { color: var(--orange); }
  .receipt-badge-wm   { color: var(--teal); background: color-mix(in srgb, var(--teal) 10%, transparent); }

  .receipt-empty {
    font-size: 12px; color: var(--text-2); font-style: italic;
    padding: 8px 0;
  }
  .receipt-empty-inline {
    font-size: 11.5px; color: var(--text-3); font-style: italic;
  }

  .receipt-grid {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 6px 14px;
    margin: 0;
    font-size: 12px;
  }
  .receipt-grid-tight { font-size: 11.5px; gap: 4px 12px; }
  .receipt-grid dt {
    color: var(--text-3); text-align: right;
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em;
    align-self: center;
  }
  .receipt-grid dd {
    margin: 0; min-width: 0;
    display: flex; align-items: center; gap: 6px;
    color: var(--text-1);
  }
  .receipt-mono {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-1);
    background: var(--surface-1);
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 0 1 auto;
  }
  .receipt-trunc { max-width: 100%; }
  .receipt-copy {
    flex: 0 0 auto;
    padding: 2px 6px;
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-2);
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
  }
  .receipt-copy:hover { color: var(--gold); border-color: var(--gold); }
  .receipt-source-extra {
    color: var(--text-2); font-size: 11px;
  }

  /* ── Watermark sub-card (path B — remote download) ──────────────── */
  .watermark-card {
    margin-top: 14px;
    padding: 12px 14px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--teal) 8%, var(--surface-1)), var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--teal) 30%, var(--border));
    border-radius: 10px;
  }
  .watermark-head {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 8px;
    font-size: 12px; color: var(--text-1);
  }
  .watermark-icon { color: var(--teal); font-size: 14px; }
  .watermark-pill {
    margin-left: auto;
    font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em;
    padding: 2px 8px; border-radius: 999px;
    background: color-mix(in srgb, var(--teal) 18%, transparent);
    color: var(--teal); text-transform: uppercase;
    border: 1px solid color-mix(in srgb, var(--teal) 40%, transparent);
  }

  .receipt-actions {
    margin-top: 12px;
    display: flex; gap: 8px; flex-wrap: wrap;
  }
  .receipt-btn {
    padding: 6px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-1);
    cursor: pointer;
    font-size: 11.5px;
  }
  .receipt-btn:hover {
    border-color: var(--gold); color: var(--gold);
  }

  /* ── Subscribed catalog repos panel (path C) ────────────────────── */
  .repos-panel {
    margin: 16px 0 24px;
    padding: 16px 18px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--purple) 8%, var(--surface-2)), var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--purple) 30%, var(--border));
    border-radius: 14px;
  }
  .repos-head {
    display: flex; align-items: center; gap: 10px;
    font-size: 12px; color: var(--text-2);
    text-transform: uppercase; letter-spacing: 0.06em;
    margin-bottom: 12px;
  }
  .repos-icon { color: var(--purple); font-size: 16px; }
  .repos-head strong { color: var(--text-1); font-weight: 600; }
  .repos-count {
    margin-left: auto;
    background: color-mix(in srgb, var(--purple) 18%, transparent);
    color: var(--purple);
    padding: 2px 8px; border-radius: 999px; font-size: 11px;
    border: 1px solid color-mix(in srgb, var(--purple) 35%, transparent);
  }
  .repos-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 12px;
  }
  .repo-card {
    padding: 12px 14px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    transition: border-color 120ms;
  }
  .repo-card:hover { border-color: color-mix(in srgb, var(--purple) 50%, var(--border)); }
  .repo-card-busy { opacity: 0.6; pointer-events: none; }
  .repo-card-error { border-color: color-mix(in srgb, var(--red) 50%, var(--border)); }
  .repo-row {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; margin-bottom: 10px;
  }
  .repo-name {
    font-size: 13px; color: var(--text-1);
    display: flex; flex-direction: column; gap: 2px;
    min-width: 0; flex: 1;
  }
  .repo-name a {
    color: var(--text-1); text-decoration: none; font-weight: 600;
    word-break: break-word;
  }
  .repo-name a:hover { color: var(--gold); }
  .repo-ref {
    font-family: var(--font-mono, monospace);
    font-size: 10.5px; color: var(--text-3);
  }
  .repo-meta {
    display: flex; flex-direction: column; gap: 4px; align-items: flex-end;
    flex-shrink: 0;
  }
  .repo-pill {
    font-size: 10.5px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--text-2);
    white-space: nowrap;
  }
  .repo-pill-items {
    color: var(--teal);
    border-color: color-mix(in srgb, var(--teal) 35%, var(--border));
    background: color-mix(in srgb, var(--teal) 8%, transparent);
  }
  .repo-pill-sync { color: var(--text-3); }
  .repo-err {
    font-size: 11px; color: var(--red);
    margin: 6px 0;
    padding: 6px 8px;
    background: color-mix(in srgb, var(--red) 8%, transparent);
    border-radius: 6px;
  }
  .repo-actions {
    display: flex; gap: 6px; flex-wrap: wrap;
  }
  .repo-btn {
    flex: 0 0 auto;
    padding: 6px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-1);
    cursor: pointer;
    font-size: 11.5px;
  }
  .repo-btn:hover:not(:disabled) {
    border-color: var(--gold); color: var(--gold);
  }
  .repo-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .repo-btn-primary {
    background: linear-gradient(135deg, color-mix(in srgb, var(--purple) 18%, var(--surface-2)), var(--surface-2));
    border-color: color-mix(in srgb, var(--purple) 40%, var(--border));
    color: var(--purple);
  }
  .repo-btn-primary:hover:not(:disabled) {
    background: var(--purple); color: var(--bg); border-color: var(--purple);
  }
  .repo-btn-danger { color: var(--red); }
  .repo-btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--red) 12%, transparent);
    border-color: var(--red); color: var(--red);
  }

  /* ── Add repo modal ─────────────────────────────────────────────── */
  .addrepo-modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(560px, 90vw);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 22px 24px;
    z-index: 100;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  }
  .addrepo-head {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 12px;
  }
  .addrepo-head h2 {
    font-size: 16px; color: var(--text-1); margin: 0;
  }
  .addrepo-hint {
    font-size: 12px; color: var(--text-2); line-height: 1.55;
    margin: 0 0 16px;
  }
  .addrepo-hint code {
    background: var(--surface-2); padding: 1px 5px; border-radius: 3px;
    font-family: var(--font-mono, monospace); font-size: 11px;
    color: var(--gold);
  }
  .addrepo-form {
    display: flex; flex-direction: column; gap: 10px;
  }
  .addrepo-form label {
    display: flex; flex-direction: column; gap: 4px;
    font-size: 12px; color: var(--text-2);
  }
  .addrepo-form label em { color: var(--red); font-style: normal; }
  .addrepo-form input {
    padding: 8px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-1);
    font-size: 13px;
  }
  .addrepo-form input:focus { outline: none; border-color: var(--purple); }
  .addrepo-err {
    font-size: 11.5px; color: var(--red);
    padding: 6px 8px;
    background: color-mix(in srgb, var(--red) 10%, transparent);
    border-radius: 6px;
  }
  .addrepo-actions {
    display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px;
  }

  .btn-install-ghost {
    background: transparent;
    color: var(--text-2);
    border: 1px solid var(--border);
  }
  .btn-install-ghost:hover {
    border-color: var(--gold); color: var(--gold);
  }
</style>
