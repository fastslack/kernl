<script context="module" lang="ts">
  import type { ModelEntry } from '$lib/model-catalog.js';

  type LlmProviderStatus = {
    slug: string;
    name: string;
    ready: boolean;
    error?: string;
    exhausted?: boolean;
    lastModel?: string;
    capabilities?: { contextWindow?: number; tools?: boolean; vision?: boolean; thinking?: boolean };
  };
  /** `hidden` = models the kernel filtered out as non-chat (image/audio/
   *  embedding/rerank). Reported so vanished models stop being silent. */
  type NonChatModel = { id: string; kind: string };
  export type ProviderWithModels = LlmProviderStatus & {
    models: ModelEntry[];
    hidden: number;
    /** The hidden ones by name, so a search for "image" can explain itself. */
    nonChat: NonChatModel[];
  };
</script>

<script lang="ts">
  /**
   * The chat's provider + model menu (custom dropdown with search).
   *
   * Only the menu lives here. The pill that opens it sits in the page header,
   * inside .cx-head's stacking context, while this menu has to render at the
   * page root to escape it — so the page keeps the trigger and drives it
   * through `toggleProvMenu` / `onProvMenuKey`, and the state the pill paints
   * (open, switching, error, current provider) is bound back up. The episode
   * list belongs to the page too: a switch or a fork is handed back through
   * `onSwitched` / `onForked`.
   *
   * The ranking and grouping are $lib/model-catalog's, shared with
   * $lib/components/agent/ModelPicker.svelte; the two stay separate components
   * because the shapes differ (lock + fork, recents strip, snapshot folding
   * here; tool-capability gating, portal and per-provider preview there).
   */
  import { tick } from 'svelte';
  import { providerColor, fmtCtx } from '$lib/chat-view.js';
  import { modelEntries } from '$lib/llm-models.js';
  import ModelTraitBadges from '$lib/components/ModelTraitBadges.svelte';
  import { buildCatalog, commonModels, rankModels, type CatalogRow } from '$lib/model-catalog.js';
  import { startChatEpisode } from '$lib/api.js';

  /** The episode the menu switches (or forks from). */
  export let selectedEp: any = undefined;
  /** Computed by the page, which also paints it on the pill. */
  export let modelLocked = false;
  /** The pill in the page header — positions the menu and takes focus back on Escape. */
  export let provMenuTrigger: HTMLButtonElement | null = null;
  export let provMenuOpen = false;
  export let providerSwitching = false;
  export let providerError = '';
  export let currentProvider: ProviderWithModels | null = null;
  export let onSwitched: (ep: any) => void = () => {};
  /** Lists the new episode and selects it; awaited, so the pill stays busy until it has. */
  export let onForked: (ep: any) => Promise<void> = async () => {};

  let availableProviders: ProviderWithModels[] = [];
  let provSearch = '';
  let provSearchInput: HTMLInputElement | null = null;
  // Menu position is computed from the trigger's bounding rect because
  // .cx-main has overflow:hidden — using `position: absolute` would clip
  // the dropdown. With `position: fixed` we escape the parent's clipping.
  let provMenuPos = { top: 0, left: 0 };

  function positionProvMenu() {
    if (!provMenuTrigger) return;
    const rect = provMenuTrigger.getBoundingClientRect();
    provMenuPos = { top: rect.bottom + 8, left: rect.left };
  }

  export async function loadAvailableProviders() {
    try {
      const r = await fetch('/api/llm-providers');
      if (!r.ok) return;
      const body = await r.json();
      const list = (body.providers ?? []) as LlmProviderStatus[];
      // Discover models per provider in parallel (only for ready ones — offline ones return empty)
      const enriched = await Promise.all(list.map(async (p) => {
        let models: ModelEntry[] = [];
        let hidden = 0;
        let nonChat: NonChatModel[] = [];
        if (p.ready) {
          try {
            const mr = await fetch(`/api/llm-providers/${encodeURIComponent(p.slug)}/models`);
            if (mr.ok) {
              const mb = await mr.json();
              models = modelEntries(mb.models);
              hidden = Number(mb.nonChatHidden ?? 0) || 0;
              nonChat = Array.isArray(mb.nonChatModels) ? mb.nonChatModels : [];
            }
          } catch { /* ignore */ }
        }
        return { ...p, models, hidden, nonChat } as ProviderWithModels;
      }));
      availableProviders = enriched;
    } catch { /* keep silent — selector just won't populate */ }
  }

  // Only close on OUTER page scrolls — scrolling inside the menu's own scroll
  // area is what the user wants. Without this filter, capture:true catches
  // every scroll event including the menu's internal one and closes prematurely.
  function onOuterScroll(e: Event) {
    const t = e.target as Node | null;
    if (t instanceof Element && t.closest('.cx-prov-menu')) return;
    closeProvMenu();
  }
  function onOuterResize() { closeProvMenu(); }

  export function toggleProvMenu() {
    if (provMenuOpen) { closeProvMenu(); return; }
    provSearch = '';
    expandedRows = new Set();
    loadRecent();
    positionProvMenu();
    provMenuOpen = true;
    void loadAvailableProviders();
    setTimeout(() => provSearchInput?.focus(), 30);
    // Use capture so we see scrolls before the inner handler — but bail out
    // when the scroll target is the menu itself (handled in onOuterScroll).
    window.addEventListener('scroll', onOuterScroll, { capture: true, passive: true });
    window.addEventListener('resize', onOuterResize);
  }
  function closeProvMenu() {
    if (!provMenuOpen) return;
    provMenuOpen = false;
    provSearch = '';
    window.removeEventListener('scroll', onOuterScroll, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', onOuterResize);
  }
  /**
   * Arrow-key navigation over the flattened, filtered list. The search input
   * keeps focus the whole time (so typing never stops working) and the active
   * row is tracked by index instead of DOM focus — hence `aria-activedescendant`
   * on the listbox rather than a roving tabindex.
   */
  export function onProvMenuKey(e: KeyboardEvent) {
    if (!provMenuOpen) return;
    if (e.key === 'Escape') { closeProvMenu(); provMenuTrigger?.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveProvActive(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveProvActive(-1); return; }
    if (e.key === 'Home') { e.preventDefault(); setProvActive(0); return; }
    if (e.key === 'End') { e.preventDefault(); setProvActive(provView.flat.length - 1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = provView.flat[provActive];
      if (row) void pickModel(row.slug, row.model);
    }
  }

  function setProvActive(i: number) {
    const n = provView.flat.length;
    if (n === 0) return;
    provActive = Math.max(0, Math.min(n - 1, i));
    void tick().then(() => {
      document.getElementById(`cx-prov-opt-${provActive}`)?.scrollIntoView({ block: 'nearest' });
    });
  }

  /** Wraps at both ends — a 30-model list is faster to reach backwards. */
  function moveProvActive(delta: number) {
    const n = provView.flat.length;
    if (n === 0) return;
    setProvActive((provActive + delta + n) % n);
  }

  async function pickModel(slug: string, model: string) {
    if (!selectedEp || !slug) return;
    // Locked chats don't switch — the menu is a launcher for a new one.
    if (modelLocked) { await forkWithModel(slug, model); return; }
    if (slug === selectedEp.llm_provider && (model || '') === (selectedEp.llm_model || '')) {
      closeProvMenu();
      return;
    }
    providerSwitching = true;
    providerError = '';
    try {
      const r = await fetch('/api/chat/episode/provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episode_id: selectedEp.id, provider: slug, model }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      onSwitched(body);
      rememberModel(slug, model);
      closeProvMenu();
    } catch (err) {
      providerError = (err as Error).message;
      setTimeout(() => (providerError = ''), 4000);
    } finally {
      providerSwitching = false;
    }
  }

  /** The way out of a locked chat: same menu, but it opens a fresh episode
   *  already pointed at the chosen model instead of rewriting this one. */
  async function forkWithModel(slug: string, model: string) {
    providerSwitching = true;
    providerError = '';
    try {
      const ep = await startChatEpisode({ provider: slug, model }) as any;
      rememberModel(slug, model);
      closeProvMenu();
      await onForked(ep);
    } catch (err) {
      providerError = (err as Error).message;
      setTimeout(() => (providerError = ''), 4000);
    } finally {
      providerSwitching = false;
    }
  }


  $: currentProvider = availableProviders.find(p => p.slug === selectedEp?.llm_provider) ?? null;

  // ── The menu's two shapes ────────────────────────────────────────
  //
  // Browsing and searching are different jobs and get different layouts.
  // Idle, the menu is a catalogue: a short strip of what you actually use,
  // then providers, then families newest-first, with dated snapshots folded
  // away. The moment there is a query all of that dissolves into one ranked
  // list — with a query the only question is "which of these did you mean",
  // and groups answer it worse. The ordering rules live in $lib/model-catalog,
  // unit-tested there.

  /** Last models picked, newest first. The only signal that knows what this
   *  person actually uses; everything else in the strip is derived. */
  let recentModels: string[] = [];
  const RECENT_KEY = 'kernl.chat.recentModels';

  function loadRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      recentModels = raw ? (JSON.parse(raw) as string[]).filter((v) => typeof v === 'string') : [];
    } catch { recentModels = []; }
  }

  function rememberModel(slug: string, model: string) {
    if (!model) return;
    const key = `${slug}::${model}`;
    recentModels = [key, ...recentModels.filter((v) => v !== key)].slice(0, 3);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentModels)); } catch { /* private mode */ }
  }

  $: searching = provSearch.trim().length > 0;

  /** Providers that can actually be picked from, in registry order. */
  $: readyProviders = availableProviders.filter((p) => p.ready);
  /** The rest still get a line while browsing: knowing Anthropic exists but
   *  needs a key is the difference between "not offered" and "not installed".
   *  They take no keyboard index — there is nothing there to choose. */
  $: offlineProviders = availableProviders.filter((p) => !p.ready);

  /** Idle: provider → families → rows, snapshots folded in. */
  $: catalogByProvider = readyProviders.map((p) => ({
    provider: p,
    groups: buildCatalog(p.models),
  }));

  /** The strip above the catalogue. Recents are stored `slug::model`, so they
   *  resolve back to the provider that owns them. */
  $: commonStrip = (() => {
    if (searching) return [];
    const out: Array<{ slug: string; name: string; row: CatalogRow }> = [];
    const seen = new Set<string>();
    for (const key of recentModels) {
      const [slug, model] = key.split('::');
      const entry = catalogByProvider.find((c) => c.provider.slug === slug);
      const row = entry?.groups.flatMap((g) => g.rows).find((r) => r.id === model);
      if (row && !seen.has(key)) { seen.add(key); out.push({ slug, name: entry!.provider.name, row }); }
    }
    for (const c of catalogByProvider) {
      for (const row of commonModels(c.groups, [], 2)) {
        const key = `${c.provider.slug}::${row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ slug: c.provider.slug, name: c.provider.name, row });
      }
    }
    return out.slice(0, 5);
  })();

  /**
   * What the query would have found if the picker listed non-chat models.
   *
   * Only consulted when nothing else matched: someone typing "image" is asking
   * a question, and "no model matches" answers it by hiding both the models
   * and the reason. These render disabled, with what they actually are.
   */
  $: hiddenHits = searching
    ? readyProviders.flatMap((p) =>
        p.nonChat
          .filter((m) => m.id.toLowerCase().includes(provSearch.trim().toLowerCase()))
          .map((m) => ({ slug: p.slug, name: p.name, model: m })))
    : [];

  /** Searching: one flat ranked list across every ready provider. */
  $: rankedHits = searching
    ? readyProviders.flatMap((p) =>
        rankModels(p.models, provSearch).map((m) => ({ slug: p.slug, name: p.name, model: m })))
    : [];

  /**
   * Numbers every selectable row once, in the order it is painted, so ↑↓ and
   * `aria-activedescendant` share one index across the strip, the catalogue and
   * the ranked list alike.
   */
  $: provView = (() => {
    const flat: Array<{ slug: string; model: string }> = [];
    const idx = new Map<string, number>();
    const key = (slug: string, model: string) => `${slug}::${model}`;
    const add = (slug: string, model: string) => {
      const k = key(slug, model);
      if (idx.has(k)) return;
      idx.set(k, flat.length);
      flat.push({ slug, model });
    };
    if (searching) {
      for (const h of rankedHits) add(h.slug, h.model.id);
    } else {
      for (const c of commonStrip) add(c.slug, c.row.id);
      for (const c of catalogByProvider) {
        add(c.provider.slug, '');
        for (const g of c.groups) for (const r of g.rows) {
          add(c.provider.slug, r.id);
          if (expandedRows.has(key(c.provider.slug, r.id))) {
            for (const sn of r.snapshots) add(c.provider.slug, sn.id);
          }
        }
      }
    }
    return { flat, idx };
  })();

  /**
   * A model in the Current strip is painted twice — once up top, once in its
   * family. `provView` deliberately gives both the same keyboard index (so ↓
   * doesn't walk the same model twice), which meant both lit up at once. The
   * first occurrence owns the highlight, and the strip is painted first.
   */
  $: stripKeys = new Set(commonStrip.map((c) => `${c.slug}::${c.row.id}`));

  /** Rows whose folded snapshots the user opened, keyed `slug::model`. */
  let expandedRows = new Set<string>();
  function toggleSnapshots(slug: string, model: string) {
    const k = `${slug}::${model}`;
    const next = new Set(expandedRows);
    if (next.has(k)) next.delete(k); else next.add(k);
    expandedRows = next;
  }

  let provActive = 0;
  // Any change to the query re-ranks the list; keeping the old index would
  // leave the highlight on an unrelated row.
  $: provSearch, (provActive = 0);

  $: provShown = searching
    ? rankedHits.length
    : catalogByProvider.reduce((n, c) => n + c.groups.reduce((m, g) => m + g.rows.length, 0), 0);
  $: provTotal = availableProviders.reduce((n, p) => n + p.models.length, 0);
</script>

{#if provMenuOpen && selectedEp}
  <div class="cx-prov-scrim" on:click={closeProvMenu} role="presentation"></div>
  <div
    class="cx-prov-menu"
    role="listbox"
    tabindex="-1"
    aria-activedescendant={provView.flat.length ? `cx-prov-opt-${provActive}` : undefined}
    on:keydown={onProvMenuKey}
    style="top: {provMenuPos.top}px; left: {provMenuPos.left}px;"
  >
    <div class="cx-prov-menu-head">
      <div class="cx-prov-head-row">
        <span>{modelLocked ? 'Start a new chat with…' : 'Provider + model'}</span>
        {#if provSearch.trim() && provTotal > 0}
          <span class="cx-prov-count">{provShown} of {provTotal}</span>
        {/if}
      </div>
      {#if modelLocked}
        <p class="cx-prov-locked-note">
          This conversation stays on <strong>{selectedEp.llm_model || currentProvider?.name || selectedEp.llm_provider}</strong>.
          Picking a model here opens a new chat.
        </p>
      {/if}
      <input
        type="text"
        class="cx-prov-search"
        placeholder="Search models…"
        aria-label="Search models"
        autocomplete="off"
        spellcheck="false"
        bind:value={provSearch}
        bind:this={provSearchInput}
      />
    </div>
    {#if availableProviders.length === 0}
      <div class="cx-prov-empty">Loading providers…</div>
    {:else if searching && rankedHits.length === 0 && hiddenHits.length > 0}
      <!-- The query found models this menu deliberately does not offer. Say
           which, and why, instead of "no match" — that answer hides the
           reason along with the models. -->
      <div class="cx-prov-hidden-hits">
        <p class="cx-prov-hidden-note">
          {hiddenHits.length} model{hiddenHits.length === 1 ? '' : 's'} match “{provSearch}”, but
          {hiddenHits.length === 1 ? 'it is not a chat model' : 'none of them are chat models'} —
          they answer on a different endpoint, so they can't hold a conversation.
        </p>
        {#each hiddenHits.slice(0, 8) as h (h.slug + '::' + h.model.id)}
          <div class="cx-prov-hidden-row">
            <span class="cx-prov-hidden-id">{h.model.id}</span>
            <span class="cx-prov-tag cx-prov-tag-kind">{h.model.kind}</span>
            <span class="cx-prov-row-prov">{h.name}</span>
          </div>
        {/each}
        {#if hiddenHits.length > 8}
          <div class="cx-prov-hidden-more">+{hiddenHits.length - 8} more</div>
        {/if}
      </div>
    {:else if searching && rankedHits.length === 0}
      <div class="cx-prov-empty">
        No model matches “{provSearch}”.
        <span class="cx-prov-empty-hint">Try a family — gpt-5, claude, grok — or a tier like mini, pro, codex.</span>
      </div>
    {:else}
      <div class="cx-prov-scroll">
        {#if searching}
          <!-- One ranked list. Best match first; the provider moves into the
               row because the grouping that used to carry it is gone. -->
          <div class="cx-prov-group-list cx-prov-flat">
            {#each rankedHits as h (h.slug + '::' + h.model.id)}
              {@const i = provView.idx.get(h.slug + '::' + h.model.id) ?? -1}
              <button
                type="button"
                id="cx-prov-opt-{i}"
                class="cx-prov-row cx-prov-row-flat"
                class:cx-prov-row-active={i === provActive}
                class:cx-prov-row-current={!modelLocked && h.slug === selectedEp.llm_provider && h.model.id === (selectedEp.llm_model || '')}
                style="--row-c: {providerColor(h.slug)}"
                role="option"
                aria-selected={h.slug === selectedEp.llm_provider && h.model.id === (selectedEp.llm_model || '')}
                disabled={providerSwitching}
                on:click={() => pickModel(h.slug, h.model.id)}
                on:mousemove={() => (provActive = i)}
              >
                <span class="cx-prov-row-name">
                  {#if h.model.hi}
                    {h.model.id.slice(0, h.model.hi[0])}<mark class="cx-prov-hi">{h.model.id.slice(h.model.hi[0], h.model.hi[1])}</mark>{h.model.id.slice(h.model.hi[1])}
                  {:else}
                    {h.model.id}
                  {/if}
                </span>
                <span class="cx-prov-row-meta">
                  {#if h.model.snapshot}<span class="cx-prov-tag cx-prov-tag-snap" title="Dated snapshot">dated</span>{/if}
                  <ModelTraitBadges traits={h.model.traits} />
                  <span class="cx-prov-row-prov">{h.name}</span>
                </span>
              </button>
            {/each}
          </div>
        {:else}
          {#if commonStrip.length}
            <div class="cx-prov-common">
              <div class="cx-prov-common-head">{recentModels.length ? 'Recent & current' : 'Current'}</div>
              {#each commonStrip as c (c.slug + '::' + c.row.id)}
                {@const i = provView.idx.get(c.slug + '::' + c.row.id) ?? -1}
                <button
                  type="button"
                  id="cx-prov-opt-{i}"
                  class="cx-prov-row cx-prov-row-flat"
                  class:cx-prov-row-active={i === provActive}
                  class:cx-prov-row-current={!modelLocked && c.slug === selectedEp.llm_provider && c.row.id === (selectedEp.llm_model || '')}
                  style="--row-c: {providerColor(c.slug)}"
                  role="option"
                  aria-selected={c.slug === selectedEp.llm_provider && c.row.id === (selectedEp.llm_model || '')}
                  disabled={providerSwitching}
                  on:click={() => pickModel(c.slug, c.row.id)}
                  on:mousemove={() => (provActive = i)}
                >
                  <span class="cx-prov-row-name">{c.row.id}</span>
                  <span class="cx-prov-row-meta">
                    <ModelTraitBadges traits={c.row.traits} />
                    <span class="cx-prov-row-prov">{c.name}</span>
                  </span>
                </button>
              {/each}
            </div>
          {/if}

          {#each catalogByProvider as c (c.provider.slug)}
            {@const di = provView.idx.get(c.provider.slug + '::') ?? -1}
            {@const shown = c.groups.reduce((n, g) => n + g.rows.length, 0)}
            <div class="cx-prov-group" style="--row-c: {providerColor(c.provider.slug)}">
              <div class="cx-prov-group-head">
                <span class="cx-prov-group-dot"></span>
                <span class="cx-prov-group-name">{c.provider.name}</span>
                <span class="cx-prov-group-meta">
                  {#if c.provider.exhausted}
                    <span class="cx-prov-status cx-prov-status-quota" title="Quota exhausted">quota</span>
                  {:else}
                    <span class="cx-prov-group-count">{shown} {shown === 1 ? 'model' : 'models'}</span>
                  {/if}
                  {#if c.provider.capabilities?.contextWindow}
                    <span class="cx-prov-sep">·</span>
                    <span class="cx-prov-group-ctx">{fmtCtx(c.provider.capabilities.contextWindow)}</span>
                  {/if}
                  {#if c.provider.hidden > 0}
                    <span class="cx-prov-sep">·</span>
                    <span
                      class="cx-prov-group-hidden"
                      title="{c.provider.hidden} model{c.provider.hidden === 1 ? '' : 's'} this provider offers are not chat models (image, audio, embeddings, rerankers). They can't answer a conversation, so they aren't listed."
                    >{c.provider.hidden} non-chat</span>
                  {/if}
                </span>
              </div>

              <div class="cx-prov-group-list">
                <button
                  type="button"
                  id="cx-prov-opt-{di}"
                  class="cx-prov-row cx-prov-row-default"
                  class:cx-prov-row-active={di === provActive}
                  class:cx-prov-row-current={!modelLocked && c.provider.slug === selectedEp.llm_provider && !selectedEp.llm_model}
                  role="option"
                  aria-selected={c.provider.slug === selectedEp.llm_provider && !selectedEp.llm_model}
                  disabled={providerSwitching}
                  on:click={() => pickModel(c.provider.slug, '')}
                  on:mousemove={() => (provActive = di)}
                >
                  <span class="cx-prov-row-name">(provider default)</span>
                </button>

                {#each c.groups as g (g.family)}
                  <!-- A divider over a single row would just repeat that row's
                       own name — claude-code's families are one model each.
                       Label a family only when it groups something. -->
                  {#if g.rows.length > 1}
                    <div class="cx-prov-fam">{g.family}</div>
                  {/if}
                  {#each g.rows as row (row.id)}
                    {@const ri = provView.idx.get(c.provider.slug + '::' + row.id) ?? -1}
                    {@const open = expandedRows.has(c.provider.slug + '::' + row.id)}
                    <div class="cx-prov-rowwrap">
                      <button
                        type="button"
                        id="cx-prov-opt-{ri}"
                        class="cx-prov-row"
                        class:cx-prov-row-active={ri === provActive && !stripKeys.has(c.provider.slug + '::' + row.id)}
                        class:cx-prov-row-current={!modelLocked && c.provider.slug === selectedEp.llm_provider && row.id === (selectedEp.llm_model || '')}
                        role="option"
                        aria-selected={c.provider.slug === selectedEp.llm_provider && row.id === (selectedEp.llm_model || '')}
                        disabled={providerSwitching}
                        on:click={() => pickModel(c.provider.slug, row.id)}
                        on:mousemove={() => (provActive = ri)}
                      >
                        <span class="cx-prov-row-name">{row.id}</span>
                        <span class="cx-prov-row-meta"><ModelTraitBadges traits={row.traits} /></span>
                      </button>
                      {#if row.snapshots.length}
                        <button
                          type="button"
                          class="cx-prov-snapbtn"
                          class:cx-prov-snapbtn-open={open}
                          aria-expanded={open}
                          title="{row.snapshots.length} dated snapshot{row.snapshots.length === 1 ? '' : 's'} of {row.id}"
                          on:click|stopPropagation={() => toggleSnapshots(c.provider.slug, row.id)}
                        >+{row.snapshots.length}</button>
                      {/if}
                    </div>
                    {#if open}
                      {#each row.snapshots as sn (sn.id)}
                        {@const si = provView.idx.get(c.provider.slug + '::' + sn.id) ?? -1}
                        <button
                          type="button"
                          id="cx-prov-opt-{si}"
                          class="cx-prov-row cx-prov-row-snap"
                          class:cx-prov-row-active={si === provActive}
                          class:cx-prov-row-current={!modelLocked && c.provider.slug === selectedEp.llm_provider && sn.id === (selectedEp.llm_model || '')}
                          role="option"
                          aria-selected={c.provider.slug === selectedEp.llm_provider && sn.id === (selectedEp.llm_model || '')}
                          disabled={providerSwitching}
                          on:click={() => pickModel(c.provider.slug, sn.id)}
                          on:mousemove={() => (provActive = si)}
                        >
                          <span class="cx-prov-row-name">{sn.id}</span>
                        </button>
                      {/each}
                    {/if}
                  {/each}
                {/each}
              </div>
            </div>
          {/each}
        {/if}

        {#if !searching && offlineProviders.length}
          <div class="cx-prov-offline">
            {#each offlineProviders as p (p.slug)}
              <div class="cx-prov-offline-row" title={p.error ?? 'Not configured'}>
                <span class="cx-prov-offline-dot"></span>
                <span class="cx-prov-offline-name">{p.name}</span>
                <span class="cx-prov-status cx-prov-status-off">offline</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <div class="cx-prov-menu-foot">
      <a href="/extensions" class="cx-prov-foot-link">Configure providers →</a>
      <span class="cx-prov-foot-keys" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> select · <kbd>esc</kbd> close</span>
    </div>
  </div>
{/if}

<style>
  .cx-prov-scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    z-index: 99;
  }
  .cx-prov-menu {
    /* `fixed` instead of `absolute` because the chat layout (.cx-main) uses
       overflow:hidden and would clip an absolutely-positioned child. We
       compute top/left from the trigger's bounding rect at open time. */
    position: fixed;
    z-index: 1000;
    min-width: 360px;
    max-width: 440px;
    background: var(--surface-1, #14181f);
    border: 1px solid var(--border-1, rgba(255, 255, 255, 0.08));
    border-radius: 10px;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.45),
      0 4px 12px rgba(0, 0, 0, 0.3),
      0 0 0 1px rgba(255, 255, 255, 0.02) inset;
    /* Don't clip — the inner .cx-prov-scroll handles its own scroll. Letting
       the menu clip (overflow:hidden) was preventing the inner scrollbar
       from being interacted with on some layouts. */
    overflow: visible;
    display: flex;
    flex-direction: column;
    max-height: min(70vh, 560px);
    animation: cx-prov-menu-in 0.14s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes cx-prov-menu-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  /* Stacks now: title row, optional lock note, then a full-width search. The
     search was a 160px box sharing a row with the title; with 30 models in the
     list it is the primary control of this menu and gets the whole width. */
  .cx-prov-menu-head {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 7px;
    padding: 9px 12px 10px 14px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
    border-bottom: 1px solid var(--border-1);
    background: rgba(255, 255, 255, 0.015);
    border-top-left-radius: 10px;
    border-top-right-radius: 10px;
    flex-shrink: 0;
  }
  .cx-prov-head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .cx-prov-count {
    font-family: var(--font-mono, monospace);
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    color: var(--text-3);
  }
  .cx-prov-locked-note {
    margin: 0;
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    line-height: 1.45;
    color: var(--text-3);
  }
  .cx-prov-locked-note strong {
    color: var(--text-2);
    font-family: var(--font-mono, monospace);
    font-weight: 600;
  }
  .cx-prov-search {
    appearance: none;
    background: var(--surface-2, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--border-1);
    border-radius: 6px;
    color: var(--text-1);
    font: inherit;
    font-size: 12px;
    text-transform: none;
    letter-spacing: 0;
    padding: 6px 9px;
    width: 100%;
  }
  .cx-prov-search:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--gold) 50%, transparent);
  }
  .cx-prov-empty {
    padding: 18px 14px;
    color: var(--text-3);
    font-size: 12px;
    text-align: center;
  }
  .cx-prov-empty-hint {
    display: block;
    margin-top: 6px;
    font-size: 11px;
    color: color-mix(in srgb, var(--text-3) 75%, transparent);
  }

  .cx-prov-scroll {
    flex: 1 1 auto;
    min-height: 0; /* required for flex children to shrink and scroll */
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .cx-prov-scroll::-webkit-scrollbar { width: 10px; }
  .cx-prov-scroll::-webkit-scrollbar-track { background: transparent; }
  .cx-prov-scroll::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--text-3) 35%, transparent);
    border-radius: 10px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }
  .cx-prov-scroll::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--text-3) 60%, transparent);
    background-clip: padding-box;
    border: 2px solid transparent;
  }

  .cx-prov-group + .cx-prov-group {
    border-top: 1px solid color-mix(in srgb, var(--border-1) 60%, transparent);
  }

  .cx-prov-group-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 6px;
    background: color-mix(in srgb, var(--row-c, var(--gold)) 6%, transparent);
    position: sticky;
    top: 0;
    z-index: 1;
    backdrop-filter: blur(6px);
  }
  .cx-prov-group-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--row-c, var(--gold));
    box-shadow: 0 0 8px color-mix(in srgb, var(--row-c, var(--gold)) 70%, transparent);
    flex-shrink: 0;
  }
  .cx-prov-group-name {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: 0.01em;
    flex: 1;
    min-width: 0;
  }
  .cx-prov-group-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--text-3);
  }
  .cx-prov-group-hidden {
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    color: color-mix(in srgb, var(--text-3) 70%, transparent);
    border-bottom: 1px dotted color-mix(in srgb, var(--text-3) 45%, transparent);
    cursor: help;
  }
  .cx-prov-group-count, .cx-prov-group-ctx {
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    color: var(--text-3);
  }
  .cx-prov-sep { opacity: 0.5; }

  .cx-prov-group-list {
    display: flex;
    flex-direction: column;
    padding: 2px 0 6px;
  }

  /* The strip above the catalogue. Set apart by ground and a rule rather than
     by a heavier label — it should read as "start here", not as a fifth
     competing header. */
  .cx-prov-common {
    padding: 4px 0 6px;
    background: color-mix(in srgb, var(--gold, #D4A84B) 4%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--border-1) 70%, transparent);
  }
  .cx-prov-common-head {
    padding: 4px 14px 5px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text-3) 85%, transparent);
  }

  /* Family divider. Deliberately the quietest text in the menu: it orients,
     it is not a thing you click. */
  .cx-prov-fam {
    padding: 7px 14px 3px 28px;
    font-family: var(--font-mono, monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text-3) 65%, transparent);
  }
  .cx-prov-group-list > .cx-prov-fam:first-of-type { padding-top: 4px; }

  /* A row and its snapshot toggle share one line. */
  .cx-prov-rowwrap { display: flex; align-items: stretch; }
  .cx-prov-rowwrap .cx-prov-row { flex: 1; min-width: 0; }
  .cx-prov-snapbtn {
    flex-shrink: 0;
    border: 0;
    background: transparent;
    color: color-mix(in srgb, var(--text-3) 75%, transparent);
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    padding: 0 12px 0 6px;
    cursor: pointer;
    transition: color 0.12s;
  }
  .cx-prov-snapbtn:hover, .cx-prov-snapbtn-open { color: var(--row-c, var(--gold)); }

  /* Snapshots sit a step further in, so an expanded row still reads as one
     thing with its variants rather than as five siblings. */
  .cx-prov-row-snap {
    padding-left: 40px;
    color: color-mix(in srgb, var(--text-2) 75%, transparent);
    font-size: 10px;
  }

  /* Search results carry their provider, since the group that used to say so
     is gone while a query is active. */
  .cx-prov-row-prov {
    font-family: var(--font-body, inherit);
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text-3) 80%, transparent);
    flex-shrink: 0;
  }
  .cx-prov-row-flat { padding-left: 14px; }
  .cx-prov-flat { padding-top: 4px; }
  .cx-prov-row-meta {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex-shrink: 0;
  }
  .cx-prov-tag {
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 1px 4px;
    border-radius: 3px;
  }
  .cx-prov-hidden-hits {
    padding: 10px 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .cx-prov-hidden-note {
    margin: 0 0 4px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-3);
  }
  .cx-prov-hidden-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: color-mix(in srgb, var(--text-3) 85%, transparent);
  }
  .cx-prov-hidden-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-prov-tag-kind {
    color: var(--gold, #D4A84B);
    background: color-mix(in srgb, var(--gold, #D4A84B) 14%, transparent);
  }
  .cx-prov-hidden-more {
    font-size: 10px;
    color: color-mix(in srgb, var(--text-3) 65%, transparent);
    padding-top: 2px;
  }
  .cx-prov-tag-snap {
    color: color-mix(in srgb, var(--text-3) 90%, transparent);
    background: color-mix(in srgb, var(--text-3) 12%, transparent);
  }

  .cx-prov-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 6px 14px 6px 28px;
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    text-align: left;
    color: var(--text-2);
    font: inherit;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }
  .cx-prov-row:hover:not(:disabled) {
    background: color-mix(in srgb, var(--row-c, var(--gold)) 10%, transparent);
    color: var(--text-1);
    border-left-color: var(--row-c, var(--gold));
  }
  .cx-prov-row:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .cx-prov-row-current {
    background: color-mix(in srgb, var(--row-c, var(--gold)) 14%, transparent);
    color: var(--row-c, var(--gold));
    border-left-color: var(--row-c, var(--gold));
    font-weight: 700;
  }
  .cx-prov-row-default {
    color: color-mix(in srgb, var(--text-1) 75%, transparent);
    font-style: italic;
  }
  /* Keyboard cursor. Deliberately reads like :hover — same row, same weight —
     because mousemove also sets it: pointer and keyboard drive one highlight
     instead of two competing ones. */
  .cx-prov-row-active:not(:disabled) {
    background: color-mix(in srgb, var(--row-c, var(--gold)) 10%, transparent);
    color: var(--text-1);
    border-left-color: var(--row-c, var(--gold));
  }
  .cx-prov-row-current.cx-prov-row-active {
    background: color-mix(in srgb, var(--row-c, var(--gold)) 18%, transparent);
    color: var(--row-c, var(--gold));
  }
  .cx-prov-row-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .cx-prov-hi {
    background: color-mix(in srgb, var(--gold, #D4A84B) 30%, transparent);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }

  .cx-prov-offline {
    border-top: 1px solid color-mix(in srgb, var(--border-1) 60%, transparent);
    padding: 6px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cx-prov-offline-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--text-3);
    cursor: help;
  }
  .cx-prov-offline-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: color-mix(in srgb, var(--text-3) 60%, transparent);
    flex-shrink: 0;
  }
  .cx-prov-offline-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .cx-prov-status {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .cx-prov-status-off {
    color: var(--text-3);
    background: color-mix(in srgb, var(--text-3) 12%, transparent);
  }
  .cx-prov-status-quota {
    color: var(--gold, #D4A84B);
    background: color-mix(in srgb, var(--gold, #D4A84B) 14%, transparent);
  }

  .cx-prov-menu-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    border-top: 1px solid var(--border-1);
    background: rgba(255, 255, 255, 0.015);
    border-bottom-left-radius: 10px;
    border-bottom-right-radius: 10px;
    flex-shrink: 0;
  }
  .cx-prov-foot-link {
    font-size: 11px;
    color: var(--text-3);
    text-decoration: none;
    transition: color 0.12s;
  }
  .cx-prov-foot-link:hover { color: var(--text-1); }
  .cx-prov-foot-keys {
    font-size: 10px;
    color: color-mix(in srgb, var(--text-3) 70%, transparent);
    white-space: nowrap;
  }
  .cx-prov-foot-keys kbd {
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    padding: 1px 4px;
    margin: 0 1px;
    border: 1px solid var(--border-1);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.03);
  }
</style>
