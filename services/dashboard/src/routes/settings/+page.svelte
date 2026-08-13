<script lang="ts">
  /**
   * Settings — catalog-driven configuration page.
   *
   * Data sources:
   *   GET /api/settings/catalog          → core settings + extension sections (generic renderer)
   *   PUT /api/settings                  → batch save of dirty catalog keys (per card)
   *   GET /api/config/ai                 → brains defaults + fallback chain
   *   POST /api/config/ai                → save brains / chain
   *   GET /api/config/ai/providers       → registry-driven provider rows (schema + masked values)
   *   GET/PUT /api/llm-providers/:slug/config → per-provider config save (raw merge, hot reload)
   *   GET /api/config/ai/test            → connectivity probe for provider rows
   *   GET /api/config/ai/lm-models       → LM Studio model discovery
   *   /api/channels*                     → runtime channels + WhatsApp QR pairing (ported)
   *   /api/registry/apis, /api/registry/rss → integration summaries
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { rpcOrCall } from '$lib/ws.js';
  import { t, locale, setUserLocale, type Locale } from '$lib/i18n/index.js';
  import Field from '$lib/components/settings/Field.svelte';
  import SecretInput from '$lib/components/settings/SecretInput.svelte';
  import SelectField from '$lib/components/settings/SelectField.svelte';
  import ClaudeCodeAuthModal from '$lib/components/ClaudeCodeAuthModal.svelte';
  import StatusPill from '$lib/components/settings/StatusPill.svelte';
  import SettingsCard from '$lib/components/settings/SettingsCard.svelte';
  import SetupChecklist from '$lib/components/settings/SetupChecklist.svelte';

  // ── Types ────────────────────────────────────
  interface CatalogItem {
    key: string;
    type: string;
    label: unknown;
    description: unknown;
    category: string;
    sensitive: boolean;
    readonly: boolean;
    value: string;
    configured: boolean;
    extension?: string;
    updated_at?: string;
  }
  interface ExtSection {
    extension: string;
    id: string;
    label: unknown;
    icon?: string;
    fields: CatalogItem[];
  }
  interface GenericCard { id: string; title: string; desc: string; items: CatalogItem[] }
  interface ProviderRow {
    slug: string;
    name: string;
    source: string;
    ready: boolean;
    error?: string;
    /** The API has always sent this and the page ignored it, which is how a
     *  provider that cannot run a single agent displayed a green READY. */
    capabilities?: { tools?: boolean };
    schema: Array<{ key: string; label: string; type: string; required?: boolean; placeholder?: string }>;
    values: Record<string, string>;
  }
  interface TestResult {
    ok: boolean; latencyMs?: number; models?: string[]; error?: string;
    /** A real completion came back. */
    answered?: boolean;
    /** It executed a tool call — the thing an agent actually needs. */
    toolCall?: boolean;
  }
  interface ChainLink { provider: string; model: string }

  // ── Load state ───────────────────────────────
  let loading = true;
  let mounted = false;
  let loadErrors: Record<string, string> = {};

  let catalog: CatalogItem[] = [];
  let extSections: ExtSection[] = [];
  let aiConfig: any = null;
  let providerRows: ProviderRow[] = [];
  let channels: any[] = [];
  let apiCount: number | null = null;
  let rssCount: number | null = null;

  // Generic editor state
  let values: Record<string, string> = {};
  let original: Record<string, string> = {};
  let fieldErrors: Record<string, string> = {};
  let cardState: Record<string, { saving?: boolean; savedMsg?: string; error?: string }> = {};

  // Toast for ported imperative actions (channels / WA)
  let msg = '';
  let msgType: 'ok' | 'err' = 'ok';
  function flash(text: string, type: 'ok' | 'err' = 'ok') {
    msg = text; msgType = type;
    setTimeout(() => (msg = ''), 4000);
  }

  async function jfetch(url: string, opts: RequestInit = {}): Promise<any> {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  const jsonHeaders = { 'Content-Type': 'application/json' };

  // Claude Code is the one provider whose credential is a login, not a key —
  // there is no field to type into, so it gets a dialog of its own.
  let ccAuthOpen = false;


  // ── Locale helpers ───────────────────────────
  function resolveText(txt: unknown, loc: string): string {
    if (txt == null) return '';
    if (typeof txt === 'string') return txt;
    if (typeof txt === 'object') {
      const o = txt as Record<string, string>;
      return o[loc] ?? o.es ?? o.en ?? Object.values(o)[0] ?? '';
    }
    return String(txt);
  }
  $: loc = (txt: unknown) => resolveText(txt, $locale);

  const isSecret = (it: CatalogItem) => it.type === 'secret' || it.sensitive;

  // ── Catalog apply / refresh ──────────────────
  function allItems(cat: CatalogItem[], ext: ExtSection[]): CatalogItem[] {
    return [...cat, ...ext.flatMap((s) => s.fields)];
  }

  function applyCatalog(
    data: { settings?: CatalogItem[]; extensionSections?: ExtSection[] },
    opts: { preserveDirty?: boolean; resetKeys?: string[] } = {},
  ) {
    const prevValues = values;
    const prevOriginal = original;
    const reset = new Set(opts.resetKeys ?? []);
    catalog = data.settings ?? [];
    extSections = data.extensionSections ?? [];
    const v: Record<string, string> = {};
    const o: Record<string, string> = {};
    for (const it of allItems(catalog, extSections)) {
      const fresh = isSecret(it) ? '' : (it.value ?? '');
      o[it.key] = fresh;
      const wasDirty =
        opts.preserveDirty &&
        !reset.has(it.key) &&
        prevValues[it.key] !== undefined &&
        prevValues[it.key] !== (prevOriginal[it.key] ?? '');
      v[it.key] = wasDirty ? prevValues[it.key] : fresh;
    }
    values = v;
    original = o;
  }

  async function refreshCatalog(resetKeys: string[] = []) {
    try {
      const data = await jfetch('/api/settings/catalog');
      applyCatalog(data, { preserveDirty: true, resetKeys });
      delete loadErrors.catalog;
      loadErrors = { ...loadErrors };
    } catch (e: any) {
      loadErrors = { ...loadErrors, catalog: e.message };
    }
  }

  // ── Initial load ─────────────────────────────
  /**
   * Nothing here may hang the page.
   *
   * Two of these go over the WebSocket RPC, which resolves only when the
   * kernel answers — and a socket that is open but silent never rejects, so
   * `Promise.allSettled` waits forever and the page sits on "Loading
   * configuration…" with no error and no way to tell what happened.
   */
  function withTimeout<T>(p: Promise<T>, label: string, ms = 12_000): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label}: no response in ${ms / 1000}s`)), ms),
      ),
    ]);
  }

  async function loadAll() {
    const tasks: Array<[string, Promise<any>]> = [
      ['catalog', jfetch('/api/settings/catalog')],
      ['ai', rpcOrCall('config.ai.get', {}, () => jfetch('/api/config/ai'))],
      ['providers', jfetch('/api/config/ai/providers')],
      ['channels', rpcOrCall('channels.list', {}, () => jfetch('/api/channels'))],
      ['apis', jfetch('/api/registry/apis')],
      ['rss', jfetch('/api/registry/rss')],
    ];
    const settled = await Promise.allSettled(
      tasks.map(([label, p]) => withTimeout(p, label)),
    );
    const errs: Record<string, string> = {};
    settled.forEach((res, i) => {
      const key = tasks[i][0];
      if (res.status === 'rejected') {
        errs[key] = res.reason?.message ?? String(res.reason);
        return;
      }
      const val = res.value;
      switch (key) {
        case 'catalog': applyCatalog(val); break;
        case 'ai': aiConfig = val; initBrains(val); break;
        case 'providers': providerRows = val.providers ?? []; initProvEdits(); break;
        case 'channels': channels = val.channels ?? val ?? []; break;
        case 'apis': apiCount = (val.apis ?? []).length; break;
        case 'rss': rssCount = (val.feeds ?? []).length; break;
      }
    });
    loadErrors = errs;
  }

  // ── Sections / routing ───────────────────────
  const CORE_SECTIONS = ['general', 'ai', 'channels', 'integrations', 'security', 'advanced'];
  $: navSections = CORE_SECTIONS.map((id) => ({ id, label: $t(`settings.nav.${id}`) }));
  $: extNav = extSections.map((s) => ({ id: `ext-${s.id}`, label: loc(s.label), icon: s.icon ?? '' }));

  $: activeSection = (() => {
    const q = $page.url.searchParams.get('section');
    if (!q) return 'general';
    if (CORE_SECTIONS.includes(q)) return q;
    // legacy aliases from the old page
    if (q === 'whatsapp' || q === 'notifications') return 'channels';
    if (q.startsWith('ext-')) return q;
    return 'general';
  })();

  function gotoSection(id: string) {
    goto(`/settings?section=${encodeURIComponent(id)}`, { noScroll: true, keepFocus: true });
  }

  // Section side effects (WA polling, lazy AI tests)
  $: if (mounted && !loading) sectionFx(activeSection);
  function sectionFx(sec: string) {
    if (sec === 'channels') {
      loadWaStatus();
      startWaPolling();
      loadWaSchema();
    } else {
      stopWaPolling();
    }
    if (sec === 'ai') ensureAiExtras();
  }

  // ── Category → section mapping ───────────────
  // Keys owned by the rich AI cards (Brains + Providers) — hidden from the
  // generic renderer to avoid double editing surfaces.
  const AI_RICH_KEYS =
    /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GROK_API_KEY|NVIDIA_API_KEY|LMSTUDIO_(BASE_URL|API_KEY|MODEL)|OLLAMA_|MINIMAX_|CHAT_DEFAULT_(PROVIDER|MODEL)|AGENTS_DEFAULT_(PROVIDER|MODEL))/;

  function sectionForItem(it: CatalogItem): string {
    if (it.extension) {
      const s = extSections.find((x) => x.extension === it.extension && x.fields.some((f) => f.key === it.key));
      return s ? `ext-${s.id}` : 'integrations';
    }
    switch (it.category) {
      case 'general': case 'life': return 'general';
      case 'ai': case 'chat': case 'agents': return 'ai';
      case 'notifications': return 'channels';
      case 'integrations': return 'integrations';
      case 'security': return 'security';
      case 'advanced': return 'advanced';
      default: return 'advanced';
    }
  }

  function computeCards(cat: CatalogItem[], ext: ExtSection[], tr: (k: string, p?: any) => string, lc: string): Record<string, GenericCard[]> {
    const by = (c: string) => cat.filter((i) => i.category === c);
    const out: Record<string, GenericCard[]> = {};

    out.general = [
      { id: 'cat-general', title: tr('settings.general.title'), desc: tr('settings.general.desc'), items: by('general') },
      { id: 'cat-life', title: tr('settings.life.title'), desc: tr('settings.life.desc'), items: by('life') },
    ].filter((c) => c.items.length);

    const aiLeft = by('ai').filter((i) => !AI_RICH_KEYS.test(i.key));
    const chatLeft = by('chat').filter((i) => !AI_RICH_KEYS.test(i.key));
    const agentsLeft = by('agents').filter((i) => !AI_RICH_KEYS.test(i.key));
    out.ai = [
      { id: 'ai-advanced', title: tr('settings.ai.advanced_title'), desc: tr('settings.ai.advanced_desc'), items: aiLeft },
      { id: 'ai-chat', title: tr('settings.ai.chat_title'), desc: tr('settings.ai.chat_desc'), items: chatLeft },
      { id: 'ai-agents', title: tr('settings.ai.agents_title'), desc: tr('settings.ai.agents_desc'), items: agentsLeft },
    ].filter((c) => c.items.length);

    // Channels: group notification keys by prefix (TELEGRAM_*, MATTERMOST_*, PROACTIVE_*…)
    const groups = new Map<string, CatalogItem[]>();
    for (const it of by('notifications')) {
      const p = it.key.split('_')[0];
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(it);
    }
    out.channels = [...groups.entries()].map(([prefix, items]) => ({
      id: `notif-${prefix}`,
      title: tr('settings.channels.catalog_title', { name: prefix.charAt(0) + prefix.slice(1).toLowerCase() }),
      desc: tr('settings.channels.catalog_desc'),
      items,
    }));

    out.integrations = [
      { id: 'cat-integrations', title: tr('settings.integrations.catalog_title'), desc: tr('settings.integrations.catalog_desc'), items: by('integrations') },
    ].filter((c) => c.items.length);

    out.security = [
      { id: 'cat-security', title: tr('settings.security.title'), desc: tr('settings.security.desc'), items: by('security') },
    ].filter((c) => c.items.length);

    out.advanced = [
      { id: 'cat-advanced', title: tr('settings.advanced.title'), desc: tr('settings.advanced.desc'), items: by('advanced') },
    ].filter((c) => c.items.length);

    for (const s of ext) {
      out[`ext-${s.id}`] = [
        { id: `ext-${s.id}`, title: resolveText(s.label, lc), desc: s.extension, items: s.fields },
      ];
    }
    return out;
  }
  $: cardsBySection = computeCards(catalog, extSections, $t, $locale);

  // ── Generic card save ────────────────────────
  function dirtyItems(items: CatalogItem[], v: Record<string, string>, o: Record<string, string>): CatalogItem[] {
    return items.filter((i) => !i.readonly && (v[i.key] ?? '') !== (o[i.key] ?? ''));
  }

  async function saveGenericCard(card: GenericCard) {
    const dirty = dirtyItems(card.items, values, original);
    if (!dirty.length) return;
    cardState = { ...cardState, [card.id]: { saving: true } };
    try {
      const entries: Record<string, string> = {};
      for (const it of dirty) entries[it.key] = values[it.key] ?? '';
      const res = await jfetch('/api/settings', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ entries }),
      });
      const errs: Array<{ key: string; error: string }> = res.errors ?? [];
      for (const it of dirty) delete fieldErrors[it.key];
      for (const e of errs) fieldErrors[e.key] = e.error;
      fieldErrors = { ...fieldErrors };

      const updated: string[] = res.updated ?? [];
      if (updated.includes('KERNEL_DEFAULT_LANGUAGE')) {
        const v = entries['KERNEL_DEFAULT_LANGUAGE'];
        if (v === 'es' || v === 'en') await setUserLocale(v as Locale);
      }
      await refreshCatalog(dirty.map((d) => d.key));
      cardState = {
        ...cardState,
        [card.id]: errs.length ? { error: $t('settings.card.error') } : { savedMsg: $t('settings.card.saved') },
      };
      setTimeout(() => {
        cardState = { ...cardState, [card.id]: {} };
      }, 2500);
    } catch (e: any) {
      cardState = { ...cardState, [card.id]: { error: e.message } };
    }
  }

  // ── Search ───────────────────────────────────
  let searchQuery = '';
  $: searchIndex = allItems(catalog, extSections).map((it) => ({
    key: it.key,
    label: loc(it.label) || it.key,
    desc: loc(it.description),
    section: sectionForItem(it),
  }));
  $: searchResults = (() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return searchIndex
      .filter((r) => r.key.toLowerCase().includes(q) || r.label.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q))
      .slice(0, 40);
  })();
  $: groupedResults = (() => {
    const m = new Map<string, typeof searchResults>();
    for (const r of searchResults) {
      if (!m.has(r.section)) m.set(r.section, []);
      m.get(r.section)!.push(r);
    }
    return [...m.entries()].map(([section, items]) => ({
      section,
      label: section.startsWith('ext-')
        ? (extNav.find((e) => e.id === section)?.label ?? section)
        : $t(`settings.nav.${section}`),
      items,
    }));
  })();

  let highlightKey = '';
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  async function jumpTo(result: { key: string; section: string }) {
    searchQuery = '';
    gotoSection(result.section);
    // Only one card is mounted at a time now, so open the one holding this
    // field first — otherwise the search lands on an element that is not in
    // the tree and the jump silently does nothing.
    const owner = (cardsBySection[result.section] ?? []).find((c) =>
      c.items.some((it: { key: string }) => it.key === result.key),
    );
    if (owner) revealCard(owner.id);
    await tick();
    highlightKey = result.key;
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => (highlightKey = ''), 2200);
    requestAnimationFrame(() => {
      const el = document.getElementById(`field-${result.key}`) ?? document.getElementById('card-providers');
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  // ═══════════════════════════════════════════════
  // AI — Brains
  // ═══════════════════════════════════════════════
  let chatProvider = '';
  let chatModel = '';
  let agentsProvider = '';
  let agentsModel = '';
  let chainLinks: ChainLink[] = [];
  let brainsInit = { chatProvider: '', chatModel: '', agentsProvider: '', agentsModel: '', chain: '' };
  let brainsSaving = false;
  let brainsMsg = '';
  let brainsErr = '';

  function initBrains(cfg: any) {
    const d = cfg?.defaults ?? {};
    chatProvider = d.chatProvider ?? '';
    chatModel = d.chatModel ?? '';
    agentsProvider = d.agentsProvider ?? '';
    agentsModel = d.agentsModel ?? '';
    chainLinks = (d.agentsDefaultModelChain ?? []).map((l: any) => ({ provider: l.provider ?? '', model: l.model ?? '' }));
    brainsInit = {
      chatProvider, chatModel, agentsProvider, agentsModel,
      chain: JSON.stringify(chainLinks),
    };
  }

  $: brainsDirty =
    chatProvider !== brainsInit.chatProvider ||
    chatModel !== brainsInit.chatModel ||
    agentsProvider !== brainsInit.agentsProvider ||
    agentsModel !== brainsInit.agentsModel ||
    JSON.stringify(chainLinks) !== brainsInit.chain;

  async function saveBrains() {
    brainsSaving = true; brainsErr = ''; brainsMsg = '';
    try {
      const body = {
        chatProvider, chatModel, agentsProvider, agentsModel,
        agentsDefaultModelChain: chainLinks.filter((l) => l.provider || l.model),
      };
      const res = await rpcOrCall('config.ai.save', body, () =>
        jfetch('/api/config/ai', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) }));
      if ((res as any)?.error) throw new Error((res as any).error);
      aiConfig = await jfetch('/api/config/ai').catch(() => aiConfig);
      initBrains(aiConfig);
      brainsMsg = $t('settings.card.saved');
      setTimeout(() => (brainsMsg = ''), 2500);
    } catch (e: any) {
      brainsErr = e.message;
    } finally {
      brainsSaving = false;
    }
  }

  function chainAdd() {
    chainLinks = [...chainLinks, { provider: providerRows[0]?.slug ?? '', model: '' }];
  }
  function chainRemove(i: number) {
    chainLinks = chainLinks.filter((_, idx) => idx !== i);
  }
  function chainMove(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= chainLinks.length) return;
    const next = [...chainLinks];
    [next[i], next[j]] = [next[j], next[i]];
    chainLinks = next;
  }

  // ── AI extras: connectivity tests + LM models ─
  let testResults: Record<string, TestResult> = {};
  let testing = false;
  let testsRan = false;
  let lmModels: string[] = [];
  let lmLoaded = false;

  async function ensureAiExtras() {
    if (!testsRan) runProviderTests();
    if (!lmLoaded) fetchLmModels();
  }
  async function runProviderTests() {
    testing = true; testsRan = true;
    try {
      const data = await rpcOrCall('config.ai.test', {}, () => jfetch('/api/config/ai/test'));
      if (data) testResults = data as Record<string, TestResult>;
    } catch { /* best effort */ }
    testing = false;
  }
  async function fetchLmModels() {
    lmLoaded = true;
    try {
      const data = await jfetch('/api/config/ai/lm-models');
      lmModels = (data.models ?? []).filter((m: string) => !m.includes('embed'));
    } catch { /* best effort */ }
  }

  /** registry slug → /api/config/ai/test result id */
  function testIdFor(slug: string): string {
    return slug === 'claude' ? 'anthropic' : slug;
  }
  function modelOptions(provider: string): string[] {
    if (!provider) return [];
    if (provider === 'lmstudio') {
      return lmModels.length ? lmModels : (testResults.lmstudio?.models ?? []);
    }
    const id = provider === 'anthropic' ? 'anthropic' : testIdFor(provider);
    return testResults[id]?.models ?? [];
  }
  $: providerOptions = providerRows.map((p) => ({ value: p.slug, label: p.name || p.slug }));

  // ═══════════════════════════════════════════════
  // AI — Provider rows
  // ═══════════════════════════════════════════════
  let provEdits: Record<string, Record<string, string>> = {};
  let provState: Record<string, { saving?: boolean; msg?: string; err?: string }> = {};

  function initProvEdits() {
    const edits: Record<string, Record<string, string>> = {};
    for (const row of providerRows) {
      const e: Record<string, string> = {};
      for (const f of row.schema ?? []) {
        e[f.key] = f.type === 'password' ? '' : (row.values?.[f.key] ?? '');
      }
      edits[row.slug] = e;
    }
    provEdits = edits;
  }

  function provRowDirty(row: ProviderRow, edits: Record<string, Record<string, string>>): boolean {
    const e = edits[row.slug];
    if (!e) return false;
    return (row.schema ?? []).some((f) =>
      f.type === 'password' ? (e[f.key] ?? '') !== '' : (e[f.key] ?? '') !== (row.values?.[f.key] ?? ''));
  }

  function hasKey(row: ProviderRow): boolean {
    if (row.ready) return true;
    return (row.schema ?? []).some((f) => f.type === 'password' && (row.values?.[f.key] ?? '') !== '' && row.values[f.key] !== '(not set)');
  }

  /**
   * Can this provider run the tool loop a native-executor agent needs?
   *
   * A finished test is evidence and wins; the declared capability is only the
   * prediction to fall back on before anyone pressed Test.
   */
  function runsTools(row: ProviderRow, tests: Record<string, TestResult> = testResults): boolean {
    const tr = tests[testIdFor(row.slug)];
    if (tr?.ok && tr.toolCall !== undefined) return tr.toolCall;
    return row.capabilities?.tools !== false;
  }

  // ── Can an agent actually run? ──────────────────────────────
  // The kernel's own verdict, from a real tool call. Read on load; the button
  // re-probes on demand because it spends a call.
  interface Readiness { ok: boolean; reason: string; provider?: string; detail?: string }
  let readiness: Readiness | null = null;
  let readinessBusy = false;

  /**
   * Which provider's form is open.
   *
   * Seven providers stacked full-height turned the one screen you go to when
   * something is broken into a scroll. The tab strip keeps every provider's
   * status visible at once — that is what you scan for — and only the row you
   * are actually editing gets expanded.
   */
  /**
   * Card-level tabs, so a section is one screen instead of a scroll.
   *
   * The rich cards are hand-written per section, the rest come from the
   * catalog, so the strip is built from both. Declared here rather than read
   * off the DOM because the tab has to exist before its card renders — only
   * one of them is in the tree at a time.
   */
  $: richCards = {
    ai: [
      { id: 'brains', title: $t('settings.ai.brains_title') },
      { id: 'providers', title: $t('settings.ai.providers_title') },
    ],
    channels: [
      { id: 'channels-runtime', title: $t('settings.channels.runtime_title') },
      { id: 'whatsapp', title: 'WhatsApp' },
    ],
  } as Record<string, Array<{ id: string; title: string }>>;

  $: cardTabs = [
    ...(richCards[activeSection] ?? []),
    ...(cardsBySection[activeSection] ?? []).map((c) => ({ id: c.id, title: c.title })),
  ];
  let activeCard = '';
  // Switching section, or landing on one whose first card changed, must not
  // leave the content area blank.
  $: if (cardTabs.length && !cardTabs.some((t) => t.id === activeCard)) activeCard = cardTabs[0].id;

  /** Search jumps to a field; open the card holding it or the jump lands nowhere. */
  function revealCard(id: string): void {
    if (cardTabs.some((t) => t.id === id)) activeCard = id;
  }

  let provTab = '';
  $: if (!provTab && providerRows.length) {
    // Open on something worth looking at: a provider that is live, else the
    // first one in the list.
    provTab = (providerRows.find((r) => r.ready) ?? providerRows[0]).slug;
  }

  async function loadReadiness(): Promise<void> {
    try {
      const r = await fetch('/api/llm/readiness');
      readiness = r.ok ? await r.json() : null;
    } catch { readiness = null; }
  }

  async function checkReadiness(): Promise<void> {
    readinessBusy = true;
    try {
      const r = await fetch('/api/llm/readiness/recheck', { method: 'POST' });
      if (r.ok) readiness = await r.json();
    } catch { /* leave the previous verdict rather than blank the banner */ }
    finally { readinessBusy = false; }
  }

  function rowStatus(row: ProviderRow, tests: Record<string, TestResult>, isTesting: boolean):
    { status: 'ok' | 'warn' | 'error' | 'neutral'; label: string } {
    const tr = tests[testIdFor(row.slug)];
    if (isTesting && !tr) return { status: 'neutral', label: '…' };
    // Reachable and still useless to a native agent. Claude Code sits here: it
    // answers, so every connectivity check passed it, but it cannot execute a
    // tool call — which is the whole job. Green was a lie; this is the truth.
    if (tr?.ok && !runsTools(row, tests)) return { status: 'warn', label: $t('settings.ai.no_tools') };
    if (tr?.ok) return { status: 'ok', label: $t('settings.ai.ready') };
    if (tr && !tr.ok && hasKey(row)) return { status: 'error', label: $t('settings.ai.error') };
    // Never configured is not broken. This branch used to sit below `row.error`,
    // so every provider you had simply not set up glowed red as a failure.
    if (!hasKey(row)) return { status: 'neutral', label: $t('settings.ai.no_key') };
    if (row.error) return { status: 'error', label: $t('settings.ai.error') };
    if (!runsTools(row, tests)) return { status: 'warn', label: $t('settings.ai.no_tools') };
    return { status: 'warn', label: $t('settings.ai.configured') };
  }

  /**
   * A schema field is a model picker by naming convention: every provider that
   * exposes a model choice calls it `defaultModel` (claude, openai, grok,
   * nvidia, minimax, claude-code). The list is dynamic per key, so it can't
   * live in the backend ConfigField schema — the UI resolves it at render.
   */
  const isModelField = (key: string) => key === 'defaultModel';

  /**
   * slug → options for that row's model dropdown. Same source the chat/agents/
   * chain dropdowns use (the probe's `testResults`, already fetched), so no
   * extra requests and one consistent list across the page.
   *
   * Reactive on purpose, and it reads `testResults`/`lmModels` DIRECTLY: a plain
   * helper called as `f(row.slug)` from the markup would only re-run when
   * `row.slug` changed, so a probe finishing in the background would never
   * repaint the dropdown. Touching them here is what registers the dependency.
   *
   * The empty option is "auto" — an empty `defaultModel` has always meant "let
   * the provider use its built-in default", and a strict dropdown without it
   * would take away the ability to go back.
   */
  $: providerModelOpts = Object.fromEntries(
    providerRows.map((row) => {
      const f = (row.schema ?? []).find((x) => isModelField(x.key));
      if (!f) return [row.slug, []];
      const models = row.slug === 'lmstudio'
        ? (lmModels.length ? lmModels : (testResults.lmstudio?.models ?? []))
        : (testResults[testIdFor(row.slug)]?.models ?? []);
      if (!models.length) return [row.slug, []];
      const auto = f.placeholder ? `${$t('settings.ai.model_auto')} — ${f.placeholder}` : $t('settings.ai.model_auto');
      return [row.slug, [{ value: '', label: auto }, ...models.map((m) => ({ value: m, label: m }))]];
    })
  ) as Record<string, Array<{ value: string; label: string }>>;

  /**
   * Per-row "Test". The probe (`/api/config/ai/test`) reads the SAVED registry
   * config — it never sees what's typed in the form. Testing a freshly pasted
   * key without persisting it re-reported the old (usually empty) state, so the
   * pill never moved and the button looked dead. Save first when dirty.
   */
  async function testProviderRow(row: ProviderRow) {
    if (provRowDirty(row, provEdits)) await saveProviderRow(row); // saves, then probes
    else await runProviderTests();
  }

  async function saveProviderRow(row: ProviderRow) {
    const edits = provEdits[row.slug] ?? {};
    provState = { ...provState, [row.slug]: { saving: true } };
    try {
      // PUT replaces settings_json wholesale → merge over the raw config so
      // untouched secrets survive (never send masked strings back).
      const cur = await jfetch(`/api/llm-providers/${encodeURIComponent(row.slug)}/config`);
      const merged: Record<string, unknown> = { ...(cur.config ?? {}) };
      for (const f of row.schema ?? []) {
        const v = edits[f.key] ?? '';
        if (f.type === 'password') {
          if (v !== '') merged[f.key] = v; // only overwrite freshly-typed secrets
        } else {
          merged[f.key] = v;
        }
      }
      const res = await jfetch(`/api/llm-providers/${encodeURIComponent(row.slug)}/config`, {
        method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ config: merged }),
      });
      if (res.error) throw new Error(res.error);
      // Refresh rows (new masked values) + re-probe connectivity
      try {
        const fresh = await jfetch('/api/config/ai/providers');
        providerRows = fresh.providers ?? providerRows;
        initProvEdits();
      } catch { /* keep local state */ }
      runProviderTests();
      provState = { ...provState, [row.slug]: { msg: $t('settings.card.saved') } };
      setTimeout(() => { provState = { ...provState, [row.slug]: {} }; }, 2500);
    } catch (e: any) {
      provState = { ...provState, [row.slug]: { err: e.message } };
    }
  }

  // ═══════════════════════════════════════════════
  // Channels (ported from the old monolith)
  // ═══════════════════════════════════════════════
  let channelSchema: any = null;
  let channelConfig: Record<string, any> = {};
  let channelId = '';
  let channelSaving = false;

  async function reloadChannels() {
    try {
      const val = await rpcOrCall('channels.list', {}, () => jfetch('/api/channels'));
      channels = (val as any).channels ?? val ?? [];
    } catch { /* keep */ }
  }

  async function loadChannelSchema(id: string) {
    channelId = id;
    try {
      const data = await rpcOrCall('channels.schema', { id }, () => jfetch(`/api/channels/schema?id=${id}`)) as any;
      channelSchema = data;
      channelConfig = {};
      for (const field of data.schema ?? []) {
        channelConfig[field.key] = data.currentConfig?.[field.key] ?? '';
      }
    } catch {
      channelSchema = null;
    }
  }

  async function saveChannel() {
    channelSaving = true;
    try {
      await rpcOrCall('channels.config.save', { id: channelId, config: channelConfig }, () =>
        jfetch('/api/channels/config', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ id: channelId, config: channelConfig }) }));
      flash(`${channelId}: ${$t('settings.card.saved')}`);
    } catch (e: any) { flash(e.message, 'err'); }
    finally { channelSaving = false; }
  }

  async function toggleChannel(id: string, running: boolean) {
    const action = running ? 'channels.stop' : 'channels.start';
    const endpoint = running ? '/api/channels/stop' : '/api/channels/start';
    try {
      await rpcOrCall(action, { id }, () => jfetch(endpoint, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ id }) }));
    } catch (e: any) { flash(e.message, 'err'); }
    await reloadChannels();
  }

  async function testChannel(id: string) {
    try {
      await rpcOrCall('channels.test', { id }, () => jfetch('/api/channels/test', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ id }) }));
      flash(`${$t('settings.channels.test')} → ${id}`);
    } catch (e: any) { flash(e.message, 'err'); }
  }

  // ── WhatsApp (ported) ────────────────────────
  let waStatus: any = {};
  let waQrString = '';
  let waPolling = false;
  let waTestPhone = '';
  let waTestMsg = '';
  let waSending = false;
  let waConfig: Record<string, any> = {};
  let waSchemaLoaded = false;
  let waSaving = false;
  let waQrInterval: ReturnType<typeof setInterval> | null = null;

  async function loadWaSchema() {
    if (waSchemaLoaded) return;
    waSchemaLoaded = true;
    try {
      const data = await rpcOrCall('channels.schema', { id: 'whatsapp' }, () => jfetch('/api/channels/schema?id=whatsapp')) as any;
      waConfig = {};
      for (const field of data.schema ?? []) {
        waConfig[field.key] = data.currentConfig?.[field.key] ?? '';
      }
    } catch { /* fields stay editable, empty */ }
  }

  async function saveWaConfig() {
    waSaving = true;
    try {
      await rpcOrCall('channels.config.save', { id: 'whatsapp', config: waConfig }, () =>
        jfetch('/api/channels/config', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ id: 'whatsapp', config: waConfig }) }));
      flash(`WhatsApp: ${$t('settings.card.saved')}`);
    } catch (e: any) { flash(e.message, 'err'); }
    finally { waSaving = false; }
  }

  async function loadWaStatus() {
    try {
      const data = await rpcOrCall('channels.qr', {}, () => jfetch('/api/channels/qr')) as any;
      waStatus = data;
      waQrString = data.qr || '';
    } catch { /* ignore */ }
  }

  function startWaPolling() {
    if (waPolling) return;
    waPolling = true;
    loadWaStatus();
    waQrInterval = setInterval(async () => {
      await loadWaStatus();
      if (waStatus.connected) stopWaPolling();
    }, 3000);
  }

  function stopWaPolling() {
    waPolling = false;
    if (waQrInterval) { clearInterval(waQrInterval); waQrInterval = null; }
  }

  async function startWhatsApp() {
    try {
      const data = await rpcOrCall('channels.start', { id: 'whatsapp' }, async () => {
        const r = await fetch('/api/channels/start', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ id: 'whatsapp' }) });
        const json = await r.json() as any;
        if (!r.ok) json.error = json.error || json.detail || 'Start failed';
        return json;
      }) as any;
      if (data.error) {
        flash(`WhatsApp error: ${data.detail || data.error}`, 'err');
        return;
      }
      flash('WhatsApp starting...');
      startWaPolling();
      await reloadChannels();
    } catch (e: any) { flash(e.message, 'err'); }
  }

  async function stopWhatsApp() {
    try {
      await rpcOrCall('channels.stop', { id: 'whatsapp' }, () =>
        jfetch('/api/channels/stop', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ id: 'whatsapp' }) }));
      stopWaPolling();
      waStatus = {};
      waQrString = '';
      flash('WhatsApp stopped');
      await reloadChannels();
    } catch (e: any) { flash(e.message, 'err'); }
  }

  async function sendWaTest() {
    if (!waTestPhone || !waTestMsg) return;
    waSending = true;
    try {
      const data = await rpcOrCall('channels.whatsapp.send', { phone: waTestPhone, message: waTestMsg }, () =>
        jfetch('/api/channels/whatsapp/send', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ phone: waTestPhone, message: waTestMsg }) })) as any;
      if (data.success) { flash('WhatsApp message sent!'); waTestMsg = ''; }
      else flash(data.error || 'Send failed', 'err');
    } catch (e: any) { flash(e.message, 'err'); }
    finally { waSending = false; }
  }

  // ── Section error banner ─────────────────────
  $: sectionError = (() => {
    // A load that failed outright is reported verbatim, not folded into the
    // "some data failed" summary — when the whole page did not load, the exact
    // message is the only thing that tells you why.
    if (loadErrors.page) return loadErrors.page;
    const src: string[] = [];
    if (loadErrors.catalog) src.push('catalog');
    if (activeSection === 'ai') {
      if (loadErrors.ai) src.push('ai');
      if (loadErrors.providers) src.push('providers');
    } else if (activeSection === 'channels') {
      if (loadErrors.channels) src.push('channels');
    } else if (activeSection === 'integrations') {
      if (loadErrors.apis) src.push('api registry');
      if (loadErrors.rss) src.push('rss registry');
    }
    return src.length ? $t('settings.section_error', { source: src.join(', ') }) : '';
  })();

  // ── Lifecycle ────────────────────────────────
  onMount(async () => {
    // `loading = false` used to sit after an unguarded await, so anything that
    // threw inside loadAll — a rejected fetch, a parse error in applyCatalog —
    // left the page on its spinner permanently, showing neither the settings
    // nor the reason. The spinner must always end, even when the load fails.
    try {
      await loadAll();
    } catch (err) {
      loadErrors = { ...loadErrors, page: err instanceof Error ? err.message : String(err) };
    } finally {
      loading = false;
    }
    mounted = true;
    sectionFx(activeSection);
    // Cached verdict — no call is spent unless the kernel already marked it
    // stale, so opening Settings stays free.
    void loadReadiness();
  });

  onDestroy(() => {
    stopWaPolling();
    if (highlightTimer) clearTimeout(highlightTimer);
  });
</script>

<div class="st-page">
  <div class="st-header">
    <h1 class="st-title">{$t('settings.title')}</h1>
    <span class="st-sub">{$t('settings.subtitle')}</span>
  </div>

  {#if msg}
    <div class="st-toast" class:err={msgType === 'err'}>{msg}</div>
  {/if}

  {#if loading}
    <div class="st-loading">{$t('settings.loading')}</div>
  {:else}
    <div class="st-layout">
      <!-- ═══ Sidebar ═══ -->
      <nav class="st-nav">
        <input
          class="st-search"
          type="text"
          placeholder={$t('settings.search')}
          bind:value={searchQuery}
          spellcheck="false"
        />

        {#if searchQuery.trim()}
          <div class="st-results">
            {#if groupedResults.length === 0}
              <div class="st-noresults">{$t('settings.search_none')}</div>
            {:else}
              {#each groupedResults as g (g.section)}
                <div class="st-result-group">{g.label}</div>
                {#each g.items as r (r.key)}
                  <button class="st-result" on:click={() => jumpTo(r)}>
                    <span class="st-result-label">{r.label}</span>
                    <span class="st-result-key">{r.key}</span>
                  </button>
                {/each}
              {/each}
            {/if}
          </div>
        {:else}
          {#each navSections as s (s.id)}
            <button class="st-nav-item" class:active={activeSection === s.id} on:click={() => gotoSection(s.id)}>
              {s.label}
            </button>
          {/each}
          {#if extNav.length}
            <div class="st-nav-divider">{$t('settings.nav.extensions')}</div>
            {#each extNav as s (s.id)}
              <button class="st-nav-item ext" class:active={activeSection === s.id} on:click={() => gotoSection(s.id)}>
                {#if s.icon}<span class="st-nav-icon">{s.icon}</span>{/if}
                {s.label}
              </button>
            {/each}
          {/if}
        {/if}
      </nav>

      <!-- ═══ Content ═══ -->
      <div class="st-content">
        {#if $page.url.searchParams.get('welcome') === '1'}
          <SetupChecklist />
        {/if}
        {#if sectionError}
          <div class="st-banner">{sectionError}</div>
        {/if}

        <!-- Card tabs — one section, one screen. Stacking every card meant the
             page you open when something is broken opened on a scroll. -->
        {#if cardTabs.length > 1}
          <div class="card-tabs" role="tablist">
            {#each cardTabs as tab (tab.id)}
              <button
                type="button"
                role="tab"
                class="card-tab"
                class:active={activeCard === tab.id}
                aria-selected={activeCard === tab.id}
                on:click={() => (activeCard = tab.id)}
              >{tab.title}</button>
            {/each}
          </div>
        {/if}

        <!-- ═══ AI (rich) ═══ -->
        {#if activeSection === 'ai' && activeCard === 'brains'}
          <!-- Brains -->
          <SettingsCard
            cardId="brains"
            title={$t('settings.ai.brains_title')}
            description={$t('settings.ai.brains_desc')}
            dirty={brainsDirty}
            saving={brainsSaving}
            savedMsg={brainsMsg}
            error={brainsErr}
            saveLabel={$t('settings.card.save')}
            savingLabel={$t('settings.card.saving')}
            on:save={saveBrains}
          >
            <div class="brains">
              <div class="brain-row">
                <span class="brain-label">{$t('settings.ai.chat_brain')}</span>
                <div class="brain-ctrls">
                  <SelectField bind:value={chatProvider} options={providerOptions} />
                  {#if modelOptions(chatProvider).length}
                    <SelectField bind:value={chatModel} options={modelOptions(chatProvider).map((m) => ({ value: m, label: m }))} />
                  {:else}
                    <input class="brain-in" type="text" bind:value={chatModel} placeholder={$t('settings.ai.model')} spellcheck="false" />
                  {/if}
                </div>
                <span class="brain-cur">{$t('settings.ai.current')}: {aiConfig?.defaults?.chatProvider ?? '?'} / {aiConfig?.defaults?.chatModel ?? '?'}</span>
              </div>

              <div class="brain-row">
                <span class="brain-label">{$t('settings.ai.agents_brain')}</span>
                <div class="brain-ctrls">
                  <SelectField bind:value={agentsProvider} options={providerOptions} />
                  {#if modelOptions(agentsProvider).length}
                    <SelectField bind:value={agentsModel} options={modelOptions(agentsProvider).map((m) => ({ value: m, label: m }))} />
                  {:else}
                    <input class="brain-in" type="text" bind:value={agentsModel} placeholder={$t('settings.ai.model')} spellcheck="false" />
                  {/if}
                </div>
                <span class="brain-cur">{$t('settings.ai.current')}: {aiConfig?.defaults?.agentsProvider ?? '?'} / {aiConfig?.defaults?.agentsModel ?? '?'}</span>
              </div>

              <div class="chain">
                <div class="chain-head">
                  <span class="brain-label">{$t('settings.ai.fallback_chain')}</span>
                  <span class="chain-hint">{$t('settings.ai.chain_hint')}</span>
                  <button class="btn-sm" on:click={chainAdd}>+ {$t('settings.ai.add_link')}</button>
                </div>
                {#if chainLinks.length === 0}
                  <div class="chain-empty">{$t('settings.ai.chain_empty')}</div>
                {:else}
                  {#each chainLinks as link, i}
                    <div class="chain-row">
                      <span class="chain-idx">{i + 1}</span>
                      <SelectField bind:value={link.provider} options={providerOptions} />
                      {#if modelOptions(link.provider).length}
                        <SelectField bind:value={link.model} options={modelOptions(link.provider).map((m) => ({ value: m, label: m }))} />
                      {:else}
                        <input class="brain-in" type="text" bind:value={link.model} placeholder={$t('settings.ai.model')} spellcheck="false" />
                      {/if}
                      <div class="chain-btns">
                        <button class="btn-sm" disabled={i === 0} on:click={() => chainMove(i, -1)}>↑</button>
                        <button class="btn-sm" disabled={i === chainLinks.length - 1} on:click={() => chainMove(i, 1)}>↓</button>
                        <button class="btn-sm del" on:click={() => chainRemove(i)}>×</button>
                      </div>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          </SettingsCard>
        {/if}

        {#if activeSection === 'ai' && activeCard === 'providers'}
          <!-- Providers -->
          <SettingsCard
            cardId="providers"
            title={$t('settings.ai.providers_title')}
            description={$t('settings.ai.providers_desc')}
            showFooter={false}
          >
            <div slot="header">
              <button class="btn-sm" disabled={readinessBusy} on:click={checkReadiness}>
                {readinessBusy ? $t('settings.ai.readiness_checking') : $t('settings.ai.readiness_check')}
              </button>
              <button class="btn-sm" disabled={testing} on:click={runProviderTests}>
                {testing ? $t('settings.ai.testing') : $t('settings.ai.test_all')}
              </button>
            </div>

            <!-- The one test that answers the question this page exists for.
                 "Test all" only proves a provider replies; it passed Claude
                 Code, which cannot execute a tool call, so every agent failed
                 while this screen showed green. This runs a real tool call. -->
            {#if readiness}
              <div class="readiness" class:ok={readiness.ok && readiness.reason === 'ok'}
                   class:partial={readiness.ok && readiness.reason !== 'ok'}
                   class:bad={!readiness.ok}>
                {#if readiness.reason === 'ok'}
                  {$t('settings.ai.readiness_ok', { provider: readiness.provider ?? '' })}
                {:else if readiness.ok}
                  {$t('settings.ai.readiness_sdk')}
                {:else}
                  {$t('settings.ai.readiness_bad', { detail: readiness.detail ?? readiness.reason })}
                {/if}
              </div>
            {/if}

            <!-- Every provider's state on one line each, always visible. The
                 form for one of them below. -->
            <div class="prov-tabs" role="tablist">
              {#each providerRows as row (row.slug)}
                {@const st = rowStatus(row, testResults, testing)}
                <button
                  type="button"
                  role="tab"
                  class="prov-tab"
                  class:active={provTab === row.slug}
                  aria-selected={provTab === row.slug}
                  on:click={() => (provTab = row.slug)}
                >
                  <span class="prov-tab-name">{row.name || row.slug}</span>
                  <StatusPill status={st.status} label={st.label} />
                  {#if provRowDirty(row, provEdits)}
                    <!-- Unsaved edits must be findable from a tab you are not
                         currently looking at. -->
                    <span class="prov-tab-dirty" title="Unsaved changes">●</span>
                  {/if}
                </button>
              {/each}
            </div>

            <div class="prov-table">
              {#each providerRows.filter((r) => r.slug === provTab) as row (row.slug)}
                {@const st = rowStatus(row, testResults, testing)}
                {@const trow = testResults[testIdFor(row.slug)]}
                <div class="prov-row">
                  <div class="prov-id">
                    <span class="prov-name">{row.name || row.slug}</span>
                    <span class="prov-slug">{row.slug}</span>
                    <StatusPill status={st.status} label={st.label} />
                    {#if trow?.ok && trow.latencyMs != null}
                      <span class="prov-lat">{trow.latencyMs}ms</span>
                    {/if}
                    {#if row.slug === 'claude-code'}
                      <button class="btn-sm" on:click={() => (ccAuthOpen = true)}>Sign in…</button>
                    {/if}
                  </div>
                  {#if !runsTools(row)}
                    <!-- Says the quiet part where the operator is looking, and
                         not only in the pill: this provider passes a
                         connectivity test and still cannot drive an agent. -->
                    <p class="prov-note">{$t('settings.ai.agents_need_tools')}</p>
                  {/if}
                  <div class="prov-fields">
                    {#each (provEdits[row.slug] ? row.schema ?? [] : []) as f (f.key)}
                      <div class="prov-field">
                        <span class="prov-flabel">{f.label || f.key}</span>
                        {#if f.type === 'password'}
                          <SecretInput
                            bind:value={provEdits[row.slug][f.key]}
                            masked={row.values?.[f.key] ?? ''}
                            configured={(row.values?.[f.key] ?? '') !== ''}
                            placeholder={f.placeholder ?? ''}
                          />
                        {:else if isModelField(f.key)}
                          {@const opts = providerModelOpts[row.slug] ?? []}
                          {#if opts.length}
                            <SelectField bind:value={provEdits[row.slug][f.key]} options={opts} />
                          {:else}
                            <!-- No catalog yet (no key, or the probe hasn't run). Fall back to
                                 free text so the row stays configurable instead of dead. -->
                            <input class="prov-in" type="text" bind:value={provEdits[row.slug][f.key]} placeholder={f.placeholder ?? ''} spellcheck="false" />
                            <span class="prov-fhint">{$t('settings.ai.model_discover')}</span>
                          {/if}
                        {:else}
                          <input class="prov-in" type="text" bind:value={provEdits[row.slug][f.key]} placeholder={f.placeholder ?? ''} spellcheck="false" />
                        {/if}
                      </div>
                    {/each}
                  </div>
                  <div class="prov-actions">
                    {#if provState[row.slug]?.err}
                      <span class="prov-msg err">{provState[row.slug].err}</span>
                    {:else if provState[row.slug]?.msg}
                      <span class="prov-msg ok">{provState[row.slug].msg}</span>
                    {:else if trow && !trow.ok && trow.error}
                      <span class="prov-msg err" title={trow.error}>{trow.error.slice(0, 60)}</span>
                    {/if}
                    <button
                      class="btn-sm"
                      disabled={testing || provState[row.slug]?.saving}
                      on:click={() => testProviderRow(row)}
                    >{$t('settings.ai.test')}</button>
                    <button
                      class="btn-sm primary"
                      disabled={!provRowDirty(row, provEdits) || provState[row.slug]?.saving}
                      on:click={() => saveProviderRow(row)}
                    >{provState[row.slug]?.saving ? $t('settings.card.saving') : $t('settings.card.save')}</button>
                  </div>
                </div>
              {/each}
            </div>
          </SettingsCard>
        {/if}

        <!-- ═══ Channels (rich) ═══ -->
        {#if activeSection === 'channels' && activeCard === 'channels-runtime'}
          <!-- Runtime channels -->
          <SettingsCard
            cardId="channels-runtime"
            title={$t('settings.channels.runtime_title')}
            description={$t('settings.channels.runtime_desc')}
            showFooter={false}
          >
            <div class="ch-grid">
              {#each channels as ch (ch.id)}
                <div class="ch-card" class:running={ch.running}>
                  <div class="ch-top">
                    <span class="ch-icon">{ch.icon ?? '📡'}</span>
                    <span class="ch-name">{ch.name}</span>
                    <span class="ch-status" style="color:{ch.running ? '#22c55e' : 'var(--text-3)'}">
                      {ch.running ? $t('settings.channels.on') : $t('settings.channels.off')}
                    </span>
                  </div>
                  <div class="ch-caps">
                    {#each ch.capabilities ?? [] as cap}
                      <span class="ch-cap">{cap}</span>
                    {/each}
                  </div>
                  <div class="ch-actions">
                    <button class="btn-sm" on:click={() => loadChannelSchema(ch.id)}>{$t('settings.channels.config')}</button>
                    <button class="btn-sm" on:click={() => toggleChannel(ch.id, ch.running)}>
                      {ch.running ? $t('settings.channels.stop') : $t('settings.channels.start')}
                    </button>
                    {#if ch.running}
                      <button class="btn-sm" on:click={() => testChannel(ch.id)}>{$t('settings.channels.test')}</button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>

            {#if channelSchema}
              <div class="ch-form">
                <div class="ch-form-title">{$t('settings.channels.config_title', { id: channelId })}</div>
                {#each channelSchema.schema ?? [] as field (field.key)}
                  <div class="ch-field">
                    <span class="ch-flabel">{field.label || field.key}{field.required ? ' *' : ''}</span>
                    {#if field.type === 'boolean'}
                      <label class="ch-toggle"><input type="checkbox" bind:checked={channelConfig[field.key]} /> {field.label || field.key}</label>
                    {:else if field.secret}
                      <SecretInput bind:value={channelConfig[field.key]} placeholder={field.placeholder ?? field.description ?? ''} />
                    {:else}
                      <input class="prov-in" type="text" bind:value={channelConfig[field.key]} placeholder={field.placeholder ?? field.description ?? ''} />
                    {/if}
                    {#if field.description}<span class="ch-fhint">{field.description}</span>{/if}
                  </div>
                {/each}
                <div class="ch-form-actions">
                  <button class="btn-sm primary" disabled={channelSaving} on:click={saveChannel}>{$t('settings.card.save')}</button>
                  <button class="btn-sm" on:click={() => (channelSchema = null)}>{$t('settings.channels.cancel')}</button>
                </div>
              </div>
            {/if}
          </SettingsCard>
        {/if}

        {#if activeSection === 'channels' && activeCard === 'whatsapp'}
          <!-- WhatsApp rich panel -->
          <SettingsCard
            cardId="whatsapp"
            title={$t('settings.wa.title')}
            description={$t('settings.wa.desc')}
            showFooter={false}
          >
            <div slot="header">
              <StatusPill
                status={waStatus.connected ? 'ok' : waQrString ? 'warn' : 'neutral'}
                label={waStatus.connected ? $t('settings.wa.connected') : waQrString ? $t('settings.wa.waiting') : $t('settings.wa.not_connected')}
              />
            </div>

            <div class="wa-body">
              {#if waStatus.connected}
                <div class="wa-connected-box">
                  <span class="wa-check">&#10003;</span>
                  <div>
                    <div class="wa-connected-text">{$t('settings.wa.connected')}</div>
                    <div class="wa-connected-phone">+{waStatus.phoneNumber || '?'}</div>
                  </div>
                  <div class="wa-conn-actions">
                    <button class="btn-sm del" on:click={stopWhatsApp}>{$t('settings.wa.disconnect')}</button>
                    <button class="btn-sm" on:click={() => testChannel('whatsapp')}>{$t('settings.wa.test_notification')}</button>
                  </div>
                </div>
              {:else if waQrString}
                <div class="wa-qr-box">
                  <img
                    src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data={encodeURIComponent(waQrString)}"
                    alt="WhatsApp QR Code"
                    class="wa-qr-img"
                    width="280"
                    height="280"
                  />
                  <div class="wa-qr-instructions">
                    <p><strong>1.</strong> {$t('settings.wa.step1')}</p>
                    <p><strong>2.</strong> {$t('settings.wa.step2')}</p>
                    <p><strong>3.</strong> {$t('settings.wa.step3')}</p>
                    <p><strong>4.</strong> {$t('settings.wa.step4')}</p>
                    <div class="wa-qr-actions">
                      <button class="btn-sm" on:click={loadWaStatus}>{$t('settings.wa.refresh_qr')}</button>
                      <button class="btn-sm del" on:click={stopWhatsApp}>{$t('settings.channels.cancel')}</button>
                    </div>
                  </div>
                </div>
              {:else}
                {#if waStatus.error}
                  <div class="wa-error-box"><strong>Error:</strong> {waStatus.error}</div>
                {/if}
                <p class="wa-hint">{$t('settings.wa.start_hint')}</p>
                <button class="btn-sm primary" on:click={startWhatsApp}>{$t('settings.wa.start')}</button>
              {/if}

              <div class="wa-config">
                <div class="ch-field">
                  <span class="ch-flabel">{$t('settings.wa.allowed')}</span>
                  <textarea class="wa-textarea" bind:value={waConfig['allowedNumbers']} placeholder="31612345678,34698765432"></textarea>
                  <span class="ch-fhint">{$t('settings.wa.allowed_hint')}</span>
                </div>
                <div class="ch-field">
                  <span class="ch-flabel">{$t('settings.wa.default_chat')}</span>
                  <input class="prov-in" type="text" bind:value={waConfig['defaultChat']} placeholder="31612345678@s.whatsapp.net" />
                  <span class="ch-fhint">{$t('settings.wa.default_chat_hint')}</span>
                </div>
                <button class="btn-sm primary" disabled={waSaving} on:click={saveWaConfig}>{$t('settings.wa.save_config')}</button>
              </div>

              {#if waStatus.connected}
                <div class="wa-config">
                  <div class="ch-form-title">{$t('settings.wa.test_title')}</div>
                  <div class="ch-field">
                    <span class="ch-flabel">{$t('settings.wa.phone')}</span>
                    <input class="prov-in" type="text" bind:value={waTestPhone} placeholder="31635311380" />
                  </div>
                  <div class="ch-field">
                    <span class="ch-flabel">{$t('settings.wa.message')}</span>
                    <textarea class="wa-textarea" bind:value={waTestMsg} placeholder="Hello from Kernl!"></textarea>
                  </div>
                  <button class="btn-sm primary" disabled={waSending || !waTestPhone || !waTestMsg} on:click={sendWaTest}>
                    {waSending ? $t('settings.wa.sending') : $t('settings.wa.send')}
                  </button>
                </div>
              {/if}
            </div>
          </SettingsCard>
        {/if}

        <!-- ═══ Integrations (rich) ═══ -->
        {#if activeSection === 'integrations'}
          <div class="int-grid">
            <div class="int-card">
              <div class="int-name">{$t('settings.integrations.api_registry')}</div>
              <div class="int-count">
                {#if apiCount != null}{$t('settings.integrations.entries', { count: apiCount })}{:else}—{/if}
              </div>
              <a class="btn-sm" href="/api-registry">{$t('settings.integrations.open')}</a>
            </div>
            <div class="int-card">
              <div class="int-name">{$t('settings.integrations.rss_registry')}</div>
              <div class="int-count">
                {#if rssCount != null}{$t('settings.integrations.feeds', { count: rssCount })}{:else}—{/if}
              </div>
              <a class="btn-sm" href="/rss-registry">{$t('settings.integrations.open')}</a>
            </div>
          </div>

        {/if}

        <!-- ═══ Generic catalog cards for the active section ═══ -->
        {#each (cardsBySection[activeSection] ?? []).filter((c) => c.id === activeCard) as card (card.id)}
          <SettingsCard
            cardId={card.id}
            title={card.title}
            description={card.desc}
            dirty={dirtyItems(card.items, values, original).length > 0}
            saving={!!cardState[card.id]?.saving}
            savedMsg={cardState[card.id]?.savedMsg ?? ''}
            error={cardState[card.id]?.error ?? ''}
            saveLabel={$t('settings.card.save')}
            savingLabel={$t('settings.card.saving')}
            on:save={() => saveGenericCard(card)}
          >
            {#each card.items as it (it.key)}
              {#if it.key === 'KERNEL_DEFAULT_LANGUAGE'}
                <div class="fld-lang" id={`field-${it.key}`}>
                  <div class="fld-lang-meta">
                    <span class="fld-lang-label">{loc(it.label) || it.key}</span>
                    <span class="fld-lang-desc">{loc(it.description)}</span>
                    <span class="fld-lang-key">{it.key}</span>
                  </div>
                  <SelectField
                    bind:value={values[it.key]}
                    options={[{ value: 'es', label: 'Español' }, { value: 'en', label: 'English' }]}
                    disabled={it.readonly}
                  />
                </div>
              {:else}
                <Field
                  fieldKey={it.key}
                  label={loc(it.label) || it.key}
                  description={loc(it.description)}
                  type={isSecret(it) ? 'secret' : it.type}
                  bind:value={values[it.key]}
                  masked={isSecret(it) ? it.value : ''}
                  configured={it.configured}
                  readonly={it.readonly}
                  error={fieldErrors[it.key] ?? ''}
                  highlight={highlightKey === it.key}
                />
              {/if}
            {/each}
          </SettingsCard>
        {/each}
      </div>
    </div>
  {/if}
</div>

<ClaudeCodeAuthModal
  open={ccAuthOpen}
  on:close={() => (ccAuthOpen = false)}
  on:changed={() => { void loadAll(); }}
/>

<style>
  .st-page { display: flex; flex-direction: column; height: calc(100vh - 56px - 48px); overflow: hidden; }
  .st-header { flex-shrink: 0; padding: 12px 0 8px; display: flex; align-items: baseline; gap: 10px; }
  .st-title { font-family: var(--font-display); font-size: 18px; font-weight: 700; margin: 0; }
  .st-sub { font-size: 11px; color: var(--text-3); }
  .st-loading { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-3); }

  .st-toast {
    flex-shrink: 0; padding: 6px 14px; border-radius: 6px; font-size: 11px; margin-bottom: 8px;
    background: rgba(34,197,94,0.1); color: #22c55e; animation: fadeIn 0.2s;
  }
  .st-toast.err { background: rgba(239,68,68,0.1); color: #ef4444; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; } }

  .st-banner {
    padding: 8px 12px; border-radius: 6px; font-size: 11px; margin-bottom: 10px;
    background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25); color: #f87171;
  }

  /* Layout */
  .st-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: 210px 1fr; gap: 12px; }

  /* Sidebar */
  .st-nav {
    display: flex; flex-direction: column; gap: 2px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 8px; height: fit-content; max-height: 100%; overflow-y: auto;
    scrollbar-width: thin;
  }
  .st-search {
    width: 100%; padding: 6px 10px; border-radius: 6px; font-size: 11px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); outline: none; box-sizing: border-box; margin-bottom: 6px;
  }
  .st-search:focus { border-color: var(--teal); }
  .st-nav-item {
    display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 6px;
    border: none; background: none; cursor: pointer; text-align: left; font-family: inherit;
    color: var(--text-2); transition: all 0.15s; width: 100%;
    font-size: 12px; font-weight: 600;
  }
  .st-nav-item:hover { background: var(--surface-2); }
  .st-nav-item.active { background: var(--surface-3); color: var(--text-1); }
  .st-nav-icon { font-size: 13px; flex-shrink: 0; }
  .st-nav-divider {
    font: 700 8px var(--font-mono); text-transform: uppercase; letter-spacing: 1px;
    color: var(--text-3); margin: 8px 4px 4px; padding-top: 8px; border-top: 1px solid var(--border);
  }

  /* Search results */
  .st-results { display: flex; flex-direction: column; gap: 1px; }
  .st-noresults { font-size: 11px; color: var(--text-3); padding: 8px 6px; }
  .st-result-group {
    font: 700 8px var(--font-mono); text-transform: uppercase; letter-spacing: 1px;
    color: var(--text-3); margin: 6px 4px 2px;
  }
  .st-result {
    display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; border-radius: 5px;
    border: none; background: none; cursor: pointer; text-align: left; font-family: inherit;
    width: 100%;
  }
  .st-result:hover { background: var(--surface-2); }
  .st-result-label { font-size: 11px; font-weight: 600; color: var(--text-1); }
  .st-result-key { font: 400 8px var(--font-mono); color: var(--text-3); word-break: break-all; }

  /* Content */
  .st-content { overflow-y: auto; padding-right: 4px; scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent; }

  /* Shared small buttons */
  .btn-sm {
    padding: 4px 10px; border-radius: 5px; font-size: 10px; font-weight: 600;
    cursor: pointer; border: 1px solid var(--border); background: none;
    color: var(--text-2); font-family: var(--font-body); text-decoration: none;
    display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
  }
  .btn-sm:hover:not(:disabled) { background: var(--surface-2); color: var(--text-1); }
  .btn-sm:disabled { opacity: 0.35; cursor: default; }
  .btn-sm.primary { background: var(--teal); border-color: var(--teal); color: var(--bg); }
  .btn-sm.primary:hover:not(:disabled) { opacity: 0.85; background: var(--teal); }
  .btn-sm.del { color: #ef4444; }
  .btn-sm.del:hover:not(:disabled) { border-color: #ef4444; background: rgba(239,68,68,0.06); }

  /* Brains */
  .brains { display: flex; flex-direction: column; gap: 10px; padding: 6px; }
  .brain-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .brain-label { font-size: 11px; font-weight: 700; color: var(--text-1); min-width: 100px; }
  .brain-ctrls { display: flex; gap: 8px; flex: 1; min-width: 240px; }
  .brain-ctrls :global(select) { max-width: 160px; }
  .brain-in {
    flex: 1; padding: 6px 10px; border-radius: 6px; font-size: 12px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-mono); outline: none; box-sizing: border-box; min-width: 0;
  }
  .brain-in:focus { border-color: var(--teal); }
  .brain-cur { font: 400 10px var(--font-mono); color: var(--text-3); }

  .chain { border-top: 1px solid var(--border); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .chain-head { display: flex; align-items: center; gap: 10px; }
  .chain-hint { font-size: 10px; color: var(--text-3); flex: 1; }
  .chain-empty { font-size: 11px; color: var(--text-3); padding: 4px 0; }
  .chain-row { display: flex; align-items: center; gap: 8px; }
  .chain-row :global(select) { max-width: 150px; }
  .chain-idx {
    font: 700 10px var(--font-mono); color: var(--text-3); width: 16px; text-align: right; flex-shrink: 0;
  }
  .chain-btns { display: flex; gap: 3px; flex-shrink: 0; }

  /* Providers table */
  .prov-table { display: flex; flex-direction: column; }
  .prov-row {
    display: grid; grid-template-columns: 190px 1fr auto; gap: 8px 14px; align-items: start;
    padding: 9px 6px; border-bottom: 1px solid var(--border);
  }
  .prov-row:last-child { border-bottom: none; }
  .prov-id { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; }
  .prov-name { font-size: 12px; font-weight: 700; color: var(--text-1); }
  .prov-slug { font: 400 9px var(--font-mono); color: var(--text-3); }
  .prov-lat { font: 400 9px var(--font-mono); color: #4ade80; }
  .prov-note {
    margin: 4px 0 0; max-width: 62ch;
    font: 400 11px/1.5 var(--font-sans, inherit); color: #e8c070;
  }

  /* ── Card tabs ──
     Section-level. Same wrap rule as the provider strip: never scroll
     sideways, because a tab you cannot see is a card you cannot reach. */
  .card-tabs {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin: 0 0 16px;
  }
  .card-tab {
    padding: 7px 14px; border-radius: 8px; cursor: pointer;
    background: rgba(120, 130, 160, .05);
    border: 1px solid rgba(120, 130, 160, .16);
    color: var(--text-2);
    font: 600 12px var(--font-sans, inherit);
    text-transform: uppercase; letter-spacing: .6px;
    transition: background .15s, border-color .15s, color .15s;
  }
  .card-tab:hover { background: rgba(120, 130, 160, .12); color: var(--text-1); }
  .card-tab.active {
    background: rgba(120, 130, 160, .18);
    border-color: rgba(120, 130, 160, .5);
    color: var(--text-1);
  }
  .card-tab:focus-visible { outline: 2px solid #4ade80; outline-offset: 2px; }

  /* ── Provider tabs ──
     Wraps rather than scrolls sideways: a hidden provider is exactly the
     failure this replaced. */
  .prov-tabs {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin: 0 0 14px; padding-bottom: 12px;
    border-bottom: 1px solid rgba(120, 130, 160, .14);
  }
  .prov-tab {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 6px 11px; border-radius: 8px; cursor: pointer;
    background: rgba(120, 130, 160, .05);
    border: 1px solid rgba(120, 130, 160, .16);
    color: var(--text-2);
    transition: background .15s, border-color .15s, color .15s;
  }
  .prov-tab:hover { background: rgba(120, 130, 160, .12); color: var(--text-1); }
  .prov-tab.active {
    background: rgba(120, 130, 160, .16);
    border-color: rgba(120, 130, 160, .45);
    color: var(--text-1);
  }
  .prov-tab:focus-visible { outline: 2px solid #4ade80; outline-offset: 2px; }
  .prov-tab-name { font: 600 12px var(--font-sans, inherit); white-space: nowrap; }
  .prov-tab-dirty { color: #e8c070; font-size: 9px; line-height: 1; }
  /* The verdict that actually decides whether the product works. Sits above
     the provider list because no single row can answer it. */
  .readiness {
    margin: 0 0 12px; padding: 10px 12px; border-radius: 8px;
    font: 400 12px/1.5 var(--font-sans, inherit);
    border: 1px solid rgba(120, 130, 160, .2); background: rgba(120, 130, 160, .06);
    color: var(--text-2);
  }
  .readiness.ok { border-color: rgba(74, 222, 128, .35); background: rgba(74, 222, 128, .08); color: #86efac; }
  .readiness.partial { border-color: rgba(232, 192, 112, .35); background: rgba(232, 192, 112, .08); color: #e8c070; }
  .readiness.bad { border-color: rgba(248, 81, 73, .35); background: rgba(248, 81, 73, .08); color: #f8a5a0; }
  .prov-fields { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .prov-field { display: grid; grid-template-columns: 110px 1fr; gap: 8px; align-items: center; }
  .prov-flabel { font-size: 10px; color: var(--text-2); }
  /* Third child of a 2-col grid — pin it under the control, not under the label. */
  .prov-fhint { grid-column: 2; font-size: 10px; color: var(--text-2); opacity: 0.8; line-height: 1.3; }
  .prov-in {
    width: 100%; padding: 6px 10px; border-radius: 6px; font-size: 12px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); outline: none; box-sizing: border-box;
  }
  .prov-in:focus { border-color: var(--teal); }
  .prov-actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; flex-wrap: wrap; max-width: 260px; }
  .prov-msg { font-size: 9px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prov-msg.ok { color: #4ade80; }
  .prov-msg.err { color: #f87171; }

  /* Channels */
  .ch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; padding: 6px; }
  .ch-card {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px; transition: all 0.15s;
  }
  .ch-card.running { border-color: rgba(34,197,94,0.3); }
  .ch-top { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .ch-icon { font-size: 15px; }
  .ch-name { font-size: 12px; font-weight: 600; flex: 1; }
  .ch-status { font-size: 9px; font-weight: 700; }
  .ch-caps { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 8px; }
  .ch-cap { font-size: 8px; padding: 1px 5px; border-radius: 3px; background: var(--surface-3); color: var(--text-3); }
  .ch-actions { display: flex; gap: 4px; flex-wrap: wrap; }

  .ch-form { margin: 8px 6px 4px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
  .ch-form-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-2); margin-bottom: 8px; }
  .ch-field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .ch-flabel { font-size: 10px; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.3px; }
  .ch-fhint { font-size: 9px; color: var(--text-3); }
  .ch-form-actions { display: flex; gap: 6px; margin-top: 4px; }
  .ch-toggle { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); cursor: pointer; }

  /* WhatsApp */
  .wa-body { padding: 6px; display: flex; flex-direction: column; gap: 12px; }
  .wa-connected-box {
    display: flex; align-items: center; gap: 12px;
    background: rgba(37,211,102,0.08); border: 1px solid rgba(37,211,102,0.25);
    border-radius: 8px; padding: 12px;
  }
  .wa-check { font-size: 22px; color: #25D366; font-weight: bold; }
  .wa-connected-text { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .wa-connected-phone { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); margin-top: 2px; }
  .wa-conn-actions { margin-left: auto; display: flex; gap: 6px; }

  .wa-qr-box { display: flex; gap: 20px; align-items: flex-start; }
  .wa-qr-img { border-radius: 8px; border: 3px solid var(--border); background: #fff; flex-shrink: 0; }
  .wa-qr-instructions { font-size: 12px; color: var(--text-2); line-height: 1.8; }
  .wa-qr-instructions p { margin: 0; }
  .wa-qr-actions { display: flex; gap: 6px; margin-top: 10px; }
  .wa-error-box {
    background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25);
    border-radius: 6px; padding: 8px 12px; font-size: 11px; color: #ef4444;
  }
  .wa-hint { font-size: 11px; color: var(--text-3); margin: 0; }
  .wa-config { border-top: 1px solid var(--border); padding-top: 10px; }
  .wa-textarea {
    min-height: 52px; resize: vertical; font-family: var(--font-mono); font-size: 11px;
    width: 100%; padding: 6px 10px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    outline: none; box-sizing: border-box;
  }
  .wa-textarea:focus { border-color: var(--teal); }

  /* Integrations */
  .int-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-bottom: 12px; }
  .int-card {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start;
  }
  .int-name { font-size: 12px; font-weight: 700; color: var(--text-1); }
  .int-count { font: 400 11px var(--font-mono); color: var(--text-2); }

  /* Language special field */
  .fld-lang {
    display: grid; grid-template-columns: minmax(180px, 1fr) minmax(200px, 1.2fr);
    gap: 4px 16px; align-items: center; padding: 8px 6px; border-bottom: 1px solid var(--border);
  }
  .fld-lang:last-child { border-bottom: none; }
  .fld-lang-meta { display: flex; flex-direction: column; gap: 1px; }
  .fld-lang-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
  .fld-lang-desc { font-size: 10px; color: var(--text-2); }
  .fld-lang-key { font: 400 9px var(--font-mono); color: var(--text-3); }

  @media (max-width: 700px) {
    .st-layout { grid-template-columns: 1fr; }
    .st-nav { flex-direction: column; max-height: 220px; }
    .prov-row { grid-template-columns: 1fr; }
    .prov-actions { justify-content: flex-start; max-width: none; }
    .wa-qr-box { flex-direction: column; align-items: center; }
    .fld-lang { grid-template-columns: 1fr; }
  }
</style>
