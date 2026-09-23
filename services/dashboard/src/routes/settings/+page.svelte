<script lang="ts">
  /**
   * Settings — catalog-driven configuration page.
   *
   * Data sources:
   *   GET /api/settings/catalog          → core settings + extension sections (generic renderer)
   *   PUT /api/settings                  → batch save of dirty catalog keys (per card)
   *   /api/llm/catalog (+ connect/test/detect) → Settings → AI (AiConnections)
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
  import StatusPill from '$lib/components/settings/StatusPill.svelte';
  import SettingsCard from '$lib/components/settings/SettingsCard.svelte';
  import SetupChecklist from '$lib/components/settings/SetupChecklist.svelte';
  import SideNav from '$lib/components/SideNav.svelte';
  import type { SideNavItem } from '$lib/components/SideNav.svelte';
  import AiConnections from '$lib/components/llm/AiConnections.svelte';
  import {
    updateInfo, checking, updating, updateError, updateHint, updateProgress,
    canApplyUpdate, refreshUpdateInfo, applyUpdate, restartKernl, updateNotice,
  } from '$lib/update.js';

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

  // ── Load state ───────────────────────────────
  let loading = true;
  let mounted = false;
  let loadErrors: Record<string, string> = {};

  let catalog: CatalogItem[] = [];
  let extSections: ExtSection[] = [];
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
        case 'channels': channels = val.channels ?? val ?? []; break;
        case 'apis': apiCount = (val.apis ?? []).length; break;
        case 'rss': rssCount = (val.feeds ?? []).length; break;
      }
    });
    loadErrors = errs;
  }

  // ── Sections / routing ───────────────────────
  const CORE_SECTIONS = ['general', 'ai', 'channels', 'integrations', 'security', 'advanced', 'about'];
  $: navSections = CORE_SECTIONS.map((id) => ({ id, label: $t(`settings.nav.${id}`) }));
  $: extNav = extSections.map((s) => ({ id: `ext-${s.id}`, label: loc(s.label), icon: s.icon ?? '' }));

  // Un solo array para el rail. El divisor cuelga del primer item de
  // extensión en vez de ser un nodo aparte, que es lo que permite que el
  // rail sea una lista plana y no una estructura de grupos.
  $: sideNavItems = [
    ...navSections.map((s): SideNavItem => ({ id: s.id, label: s.label })),
    ...extNav.map((s, i): SideNavItem => ({
      id: s.id,
      label: s.label,
      icon: s.icon || undefined,
      divider: i === 0 ? $t('settings.nav.extensions') : undefined,
    })),
  ];

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
  }

  // ── Category → section mapping ───────────────
  // Keys the AI connections card owns — hidden from the generic renderer.
  const AI_RICH_KEYS = /^(LMSTUDIO_(BASE_URL|API_KEY)|MINIMAX_)/;

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

  $: richCards = {
    ai: [
      { id: 'providers', title: $t('llm.connections') },
    ],
    channels: [
      { id: 'channels-runtime', title: $t('settings.channels.runtime_title') },
      { id: 'whatsapp', title: 'WhatsApp' },
    ],
    about: [
      { id: 'about', title: $t('settings.about.title') },
    ],
  } as Record<string, Array<{ id: string; title: string }>>;

  // ── About ────────────────────────────────────────────────────────
  //
  // Facts about the program itself rather than settings to change, so the card
  // is read-only (`showFooter={false}`) — there is nothing here to save.
  //
  // The version state is NOT fetched here: it lives in $lib/update.js, which
  // the shell's notice strip already populates on mount. Sharing it is the
  // point — updating from this card makes the strip above it go away by
  // itself, and "Check for updates" refreshes both at once.
  const ABOUT = {
    name: 'Kernl',
    license: 'Apache-2.0',
    author: 'Matias Aguirre',
    repo: 'https://github.com/fastslack/kernl',
    releases: 'https://github.com/fastslack/kernl/releases',
  };

  /** "hace 5 min" for the cache stamp the kernel returns with a check. */
  function checkedAgo(epoch: number | undefined, _lc: string): string {
    if (!epoch) return '';
    const s = Math.max(0, Math.round((Date.now() - epoch) / 1000));
    if (s < 60) return $t('settings.about.checked_now');
    if (s < 3600) return $t('settings.about.checked_min', { n: Math.round(s / 60) });
    if (s < 86400) return $t('settings.about.checked_hour', { n: Math.round(s / 3600) });
    return $t('settings.about.checked_day', { n: Math.round(s / 86400) });
  }
  // Recomputed on every locale switch AND whenever a check lands, so the stamp
  // is never a frozen "just now" from the first render.
  $: checkedLabel = checkedAgo($updateInfo?.checkedAt, $locale);

  $: cardTabs = [
    ...(richCards[activeSection] ?? []),
    ...(cardsBySection[activeSection] ?? []).map((c) => ({ id: c.id, title: c.title })),
  ];
  let activeCard = '';
  // Switching section, or landing on one whose first card changed, must not
  // leave the content area blank.
  $: if (cardTabs.length && !cardTabs.some((t) => t.id === activeCard)) activeCard = cardTabs[0].id;

  /**
   * `?card=` opens a specific card, so somewhere else in the app can send a
   * reader to the exact thing they have to fix — `?section=ai&card=providers`
   * from an agent run that died with no LLM configured, for instance. Applied
   * once per value: after that the tab strip is the user's to drive.
   */
  let appliedCardParam = '';
  $: {
    const wanted = $page.url.searchParams.get('card') ?? '';
    if (wanted && wanted !== appliedCardParam && cardTabs.some((t) => t.id === wanted)) {
      appliedCardParam = wanted;
      activeCard = wanted;
    }
  }

  /** Search jumps to a field; open the card holding it or the jump lands nowhere. */
  function revealCard(id: string): void {
    if (cardTabs.some((t) => t.id === id)) activeCard = id;
  }

  // ═══════════════════════════════════════════════
  // Channels (ported from the old monolith)
  // ═══════════════════════════════════════════════
  let channelSchema: any = null;
  let channelConfig: Record<string, any> = {};
  // Masked stored value per secret field — the SecretInput placeholder.
  let channelMasked: Record<string, string> = {};
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
      channelMasked = {};
      // channels.schema answers `config`, with every password field masked.
      // A secret field holds only what the user types (blank keeps the stored
      // value on save); the mask is shown as its placeholder.
      for (const field of data.schema ?? []) {
        const current = data.config?.[field.key] ?? '';
        if (field.type === 'password' || field.secret) {
          channelConfig[field.key] = '';
          channelMasked[field.key] = current;
        } else {
          channelConfig[field.key] = current;
        }
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
        waConfig[field.key] = data.config?.[field.key] ?? '';
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
    if (activeSection === 'channels') {
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
    <div class="sidenav-layout">
      <!-- ═══ Sidebar ═══ -->
      {#if searchQuery.trim()}
        <SideNav items={[]} active="" onSelect={() => {}} ariaLabel={$t('settings.search')}>
          <svelte:fragment slot="top">
            <input
              class="st-search"
              type="text"
              placeholder={$t('settings.search')}
              bind:value={searchQuery}
              spellcheck="false"
            />
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
          </svelte:fragment>
        </SideNav>
      {:else}
        <SideNav
          items={sideNavItems}
          active={activeSection}
          onSelect={gotoSection}
          ariaLabel={$t('settings.search')}
        >
          <svelte:fragment slot="top">
            <input
              class="st-search"
              type="text"
              placeholder={$t('settings.search')}
              bind:value={searchQuery}
              spellcheck="false"
            />
          </svelte:fragment>
        </SideNav>
      {/if}

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

        <!-- ═══ AI ═══ -->
        {#if activeSection === 'ai' && activeCard === 'providers'}
          <AiConnections
            initialConnect={$page.url.searchParams.get('connect') ?? ''}
            on:advanced={() => revealCard('ai-advanced')}
          />
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
                    {:else if field.type === 'password' || field.secret}
                      <SecretInput bind:value={channelConfig[field.key]} masked={channelMasked[field.key] ?? ''} configured={!!channelMasked[field.key]} placeholder={field.placeholder ?? field.description ?? ''} />
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

        <!-- ═══ About (rich) ═══ -->
        {#if activeSection === 'about' && activeCard === 'about'}
          <SettingsCard
            cardId="about"
            title={$t('settings.about.title')}
            description={$t('settings.about.desc')}
            showFooter={false}
          >
            <div class="about">
              <!-- Identity. The mascot is the same asset the header uses, so
                   the program is recognisable here by the face it already
                   wears everywhere else. -->
              <div class="about-id">
                <img class="about-logo" src="/mascot.png" alt="" />
                <div class="about-id-text">
                  <div class="about-name">{ABOUT.name}</div>
                  <div class="about-version">
                    {#if $updateInfo}
                      v{$updateInfo.current}
                    {:else}
                      <span class="about-dim">{$t('settings.about.version_unknown')}</span>
                    {/if}
                  </div>
                  <div class="about-tagline">{$t('settings.about.tagline')}</div>
                </div>
              </div>

              <!-- Version state. Three outcomes, and the third one matters:
                   a check that could not answer must read as "unknown", never
                   as "you are up to date" — telling someone they are current
                   when nobody asked the release host is the one wrong answer
                   this card can give. -->
              <div class="about-update" class:has-update={$updateInfo?.updateAvailable}>
                {#if $updateInfo?.updateAvailable}
                  <span class="about-update-dot" aria-hidden="true"></span>
                  <span class="about-update-msg">
                    {$t('settings.about.available', { version: $updateInfo.latest ?? '' })}
                  </span>
                  {#if $updateInfo.url}
                    <a class="about-link" href={$updateInfo.url} target="_blank" rel="noreferrer">
                      {$t('settings.about.changelog')}
                    </a>
                  {/if}
                  {#if $canApplyUpdate}
                    <button class="btn-sm primary" disabled={$updating} on:click={applyUpdate}>
                      {$updating ? $t('settings.about.updating') : $t('settings.about.update_now')}
                    </button>
                  {:else}
                    <!-- The install cannot replace itself; say why and what to
                         do instead of offering a button that can only refuse. -->
                    <span class="about-update-msg about-dim">{$updateInfo.install?.reason ?? ''}</span>
                    {#if $updateInfo.install?.hint}<code>{$updateInfo.install.hint}</code>{/if}
                  {/if}
                  {#if $updating && $updateProgress}
                    <!-- Everything slow — the download, the checksum, the
                         unpack — happens before the kernel exits, so this page
                         is around to show it. Determinate when the server sent
                         a content-length, indeterminate when it did not: a
                         made-up percentage is worse than an honest spinner. -->
                    {@const p = $updateProgress}
                    {@const pct = p.total > 0 ? Math.round((p.received / p.total) * 100) : null}
                    <div class="upd-progress">
                      <div class="upd-bar" class:indeterminate={pct === null}>
                        <span style={pct === null ? '' : `width:${pct}%`}></span>
                      </div>
                      <span class="upd-phase">
                        {p.phase === 'downloading'
                          ? (pct === null
                              ? `${(p.received / 1048576).toFixed(1)} MB`
                              : `${pct}% · ${(p.received / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(1)} MB`)
                          : p.phase}
                      </span>
                    </div>
                  {/if}
                {:else if $updateInfo?.latest}
                  <span class="about-update-msg">
                    {$t('settings.about.current', { version: $updateInfo.current })}
                  </span>
                {:else if !$updateError}
                  <!-- Only when nothing else explains the silence. A staged
                       update clears updateInfo on purpose, and "could not
                       check" is the wrong caption for "we are restarting" —
                       the error line below is already saying the true thing. -->
                  <span class="about-update-msg about-dim">{$t('settings.about.check_failed')}</span>
                {/if}
                <button class="btn-sm" disabled={$checking} on:click={() => refreshUpdateInfo(true)}>
                  {$checking ? $t('settings.about.checking') : $t('settings.about.check')}
                </button>
                {#if checkedLabel}<span class="about-checked">{checkedLabel}</span>{/if}
                <!-- An updated extension only runs after a restart. Offered for
                     every installed copy — the kernel relaunches itself the way
                     it was started — and hidden for a source checkout, which
                     has no entry point to relaunch. -->
                {#if $updateInfo?.install?.kind && $updateInfo.install.kind !== 'unknown'}
                  <button class="btn-sm" disabled={$updating} on:click={restartKernl}>
                    {$updating ? $t('settings.about.restarting') : $t('settings.about.restart')}
                  </button>
                {/if}
              </div>

              {#if $updateNotice && !$updateError}
                <p class="about-update-msg">{$updateNotice}</p>
              {/if}

              {#if $updateError}
                <p class="about-err">
                  {$updateError}
                  {#if $updateHint}<code>{$updateHint}</code>{/if}
                </p>
              {/if}

              <!-- Details. -->
              <dl class="about-facts">
                <dt>{$t('settings.about.license')}</dt>
                <dd>{ABOUT.license}</dd>
                <dt>{$t('settings.about.author')}</dt>
                <dd>{ABOUT.author}</dd>
                <dt>{$t('settings.about.source')}</dt>
                <dd>
                  <a class="about-link" href={ABOUT.repo} target="_blank" rel="noreferrer">
                    {ABOUT.repo.replace('https://', '')}
                  </a>
                </dd>
                <dt>{$t('settings.about.releases')}</dt>
                <dd>
                  <a class="about-link" href={ABOUT.releases} target="_blank" rel="noreferrer">
                    {$t('settings.about.releases_link')}
                  </a>
                </dd>
              </dl>
            </div>
          </SettingsCard>
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

  /* El layout (`.sidenav-layout`) vive en app.css y el rail en
     $lib/components/SideNav.svelte. Lo que queda acá es el buscador y sus
     resultados, que Settings inyecta por el slot `top` del rail: indexan
     claves del catálogo, no items de navegación. */
  .st-search {
    width: 100%; padding: 6px 10px; border-radius: 6px; font-size: 11px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); outline: none; box-sizing: border-box; margin-bottom: 6px;
  }
  .st-search:focus { border-color: var(--teal); }

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

  /* Shared text input style — still used by the Channels/WhatsApp config
     fields below, so it stays even though the AI provider rows that named it
     are gone. */
  .prov-in {
    width: 100%; padding: 6px 10px; border-radius: 6px; font-size: 12px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); outline: none; box-sizing: border-box;
  }
  .prov-in:focus { border-color: var(--teal); }

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

  /* ── About ─────────────────────────────────────────────────────
     A read-only card, so nothing here is a control except the two update
     buttons — the rest is typography with a clear hierarchy: what you are
     running first, whether it is current second, the fine print last. */
  .about { display: flex; flex-direction: column; gap: 18px; }

  .about-id { display: flex; align-items: center; gap: 14px; }
  .about-logo { width: 52px; height: 52px; flex: none; border-radius: 10px; object-fit: contain; }
  .about-id-text { min-width: 0; }
  .about-name { font-size: 17px; font-weight: 700; color: var(--text-1); line-height: 1.2; }
  .about-version { font: 700 13px var(--font-mono); color: var(--teal); margin-top: 2px; }
  .about-tagline { font-size: 11.5px; color: var(--text-2); margin-top: 4px; max-width: 52ch; line-height: 1.5; }
  .about-dim { color: var(--text-3); font-weight: 400; }

  /* Same wrap-and-share-a-baseline treatment as the shell's update strip:
     every control is `flex: none`, so without wrapping a narrow settings
     column pushes the buttons out of the card. */
  .about-update {
    display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
    padding: 10px 12px; border-radius: var(--radius-sm, 6px);
    background: var(--surface-2); border: 1px solid var(--border);
    font-size: 12px; line-height: 20px; color: var(--text-2);
  }
  .about-update.has-update {
    background: rgba(240, 180, 41, 0.10);
    border-color: rgba(240, 180, 41, 0.30);
    color: var(--gold);
  }
  .about-update-dot {
    flex: none; width: 7px; height: 7px; border-radius: 50%;
    background: var(--gold); box-shadow: 0 0 6px var(--gold);
  }
  /* The flexible cell — it absorbs the free width so the buttons sit against
     the right edge whether or not the changelog link is there to render. */
  .about-update-msg { flex: 1 1 auto; min-width: 0; }
  .about-checked { flex: none; font: 400 10px var(--font-mono); color: var(--text-3); }
  .about-link { color: inherit; text-decoration: underline; flex: none; }

  .about-err {
    margin: 0; font-size: 11.5px; color: var(--red);
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  }
  .about-err code {
    font: 400 11px var(--font-mono); padding: 2px 6px;
    border-radius: 4px; background: rgba(0, 0, 0, 0.3);
  }

  /* A definition list, not a table: two columns that stay aligned down the
     card and collapse to one on a narrow column. */
  .about-facts {
    display: grid; grid-template-columns: minmax(90px, max-content) 1fr;
    gap: 7px 16px; margin: 0; font-size: 12px;
  }
  .about-facts dt { color: var(--text-3); }
  .about-facts dd { margin: 0; color: var(--text-1); overflow-wrap: anywhere; }
  @media (max-width: 520px) {
    .about-facts { grid-template-columns: 1fr; gap: 2px 0; }
    .about-facts dd { margin-bottom: 8px; }
  }

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
    .wa-qr-box { flex-direction: column; align-items: center; }
    .fld-lang { grid-template-columns: 1fr; }
  }

  /* Update progress. Indeterminate when the server sends no content-length —
     a sliding band rather than a percentage nobody can stand behind. */
  .upd-progress { display: flex; align-items: center; gap: .5rem; width: 100%; margin-top: .5rem; }
  .upd-bar { position: relative; flex: 1; height: 6px; border-radius: 999px;
             background: rgba(255, 255, 255, .12); overflow: hidden; }
  .upd-bar > span { display: block; height: 100%; border-radius: 999px;
                    background: #6366f1; transition: width 200ms ease; }
  .upd-bar.indeterminate > span { width: 35%; animation: upd-slide 1.1s ease-in-out infinite; }
  @keyframes upd-slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
  }
  .upd-phase { font-size: .75rem; opacity: .75; white-space: nowrap;
               font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) {
    .upd-bar.indeterminate > span { animation: none; width: 100%; opacity: .5; }
  }
</style>
