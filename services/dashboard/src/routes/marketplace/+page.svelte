<script lang="ts">
  import { goto } from '$app/navigation';
  import { marketplace, activeTheme } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import {
    marketplaceInstall, marketplaceUninstall, marketplaceEnable, marketplaceDisable,
    marketplaceActivateTheme, marketplaceDeactivateTheme, marketplaceExport, marketplaceReview,
  } from '$lib/api.js';

  // ── Data ───────────────────────────────────────────────
  $: mp = $marketplace as any;
  $: allItems = (mp?.items ?? []) as any[];
  $: themes = (mp?.themes ?? []) as any[];
  $: stats = mp?.stats ?? { total: 0, installed: 0, active: 0, byType: {} };
  $: currentTheme = mp?.activeTheme ?? null;

  // ── Tabs ───────────────────────────────────────────────
  type TabId = 'all' | 'extension' | 'agent' | 'flow' | 'theme' | 'template' | 'installed';
  let activeTab: TabId = 'all';

  const TABS: Array<{ id: TabId; label: string; icon: string }> = [
    { id: 'all', label: 'All', icon: '🏪' },
    { id: 'extension', label: 'Extensions', icon: '🔧' },
    { id: 'agent', label: 'Agents', icon: '🤖' },
    { id: 'flow', label: 'Flows', icon: '⬡' },
    { id: 'theme', label: 'Themes', icon: '🎨' },
    { id: 'template', label: 'Templates', icon: '📄' },
    { id: 'installed', label: 'My Items', icon: '📦' },
  ];

  // ── Search & Filter ───────────────────────────────────
  let search = '';

  function isInstalled(item: any) {
    return item.status === 'installed' || item.status === 'active' || item.status === 'disabled';
  }

  function applySearch(items: any[]) {
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter((i: any) =>
      i.name?.toLowerCase().includes(q) ||
      i.description?.toLowerCase().includes(q) ||
      (i.tags ?? '').toLowerCase().includes(q)
    );
  }

  // Split items into two groups for clear visual separation
  $: filteredInstalled = (() => {
    let items = allItems.filter(isInstalled);
    if (activeTab !== 'all' && activeTab !== 'installed') {
      items = items.filter((i: any) => i.type === activeTab);
    }
    return applySearch(items);
  })();

  $: filteredAvailable = (() => {
    if (activeTab === 'installed') return [];
    let items = allItems.filter((i: any) => !isInstalled(i));
    if (activeTab !== 'all') {
      items = items.filter((i: any) => i.type === activeTab);
    }
    return applySearch(items);
  })();

  $: totalFiltered = filteredInstalled.length + filteredAvailable.length;

  // ── Type counts ───────────────────────────────────────
  $: typeCounts = (() => {
    const c: Record<string, number> = { all: allItems.length, installed: 0 };
    for (const item of allItems) {
      c[item.type] = (c[item.type] ?? 0) + 1;
      if (item.status === 'installed' || item.status === 'active' || item.status === 'disabled') c.installed++;
    }
    return c;
  })();

  // ── Actions ───────────────────────────────────────────
  let loadingId: string | null = null;
  let actionMsg: Record<string, { text: string; ok: boolean }> = {};

  async function doAction(id: string, action: string) {
    loadingId = id;
    actionMsg[id] = { text: '', ok: true };
    try {
      if (action === 'install') await marketplaceInstall(id);
      else if (action === 'uninstall') await marketplaceUninstall(id);
      else if (action === 'enable') await marketplaceEnable(id);
      else if (action === 'disable') await marketplaceDisable(id);
      else if (action === 'activate-theme') await marketplaceActivateTheme(id);
      else if (action === 'deactivate-theme') await marketplaceDeactivateTheme();

      actionMsg[id] = { text: '✓ Done', ok: true };
      // Refresh marketplace data
      const mpData = await rpcOrCall('marketplace.list', {}, async () => {
        const r = await fetch('/api/marketplace');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      marketplace.set(mpData);
      // Refresh active theme
      const themeData = await rpcOrCall('marketplace.theme.active', {}, async () => {
        const tr = await fetch('/api/marketplace/theme/active');
        if (!tr.ok) throw new Error(`HTTP ${tr.status}`);
        return tr.json();
      });
      activeTheme.set(themeData.theme ?? null);
    } catch (e: any) {
      actionMsg[id] = { text: e.message, ok: false };
    } finally {
      loadingId = null;
      actionMsg = { ...actionMsg };
    }
  }

  async function doExport(id: string, name: string) {
    try {
      const pkg = await marketplaceExport(id);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.toLowerCase().replace(/\s+/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert('Export failed: ' + e.message);
    }
  }

  // ── Theme preview ─────────────────────────────────────
  let previewingThemeId: string | null = null;
  let originalVars: string | null = null;

  function previewTheme(themeRow: any) {
    if (previewingThemeId === themeRow.item_id) {
      cancelPreview();
      return;
    }
    // Save current state
    if (!originalVars) {
      const shell = document.querySelector('.app-shell') as HTMLElement;
      originalVars = shell?.getAttribute('style') ?? '';
    }
    // Apply preview vars
    const vars = JSON.parse(themeRow.variables) as Record<string, string>;
    const style = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
    const shell = document.querySelector('.app-shell') as HTMLElement;
    if (shell) shell.setAttribute('style', style);
    previewingThemeId = themeRow.item_id;
  }

  function cancelPreview() {
    if (originalVars !== null) {
      const shell = document.querySelector('.app-shell') as HTMLElement;
      if (shell) shell.setAttribute('style', originalVars);
      originalVars = null;
    }
    previewingThemeId = null;
  }

  // ── Helpers ───────────────────────────────────────────
  function stars(rating: number): string {
    return '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
  }

  function parseTags(tags: string): string[] {
    try { return JSON.parse(tags); } catch { return []; }
  }

  function fmtPrice(cents: number, currency: string): string {
    return cents === 0 ? 'FREE' : `${(cents / 100).toFixed(2)} ${currency}`;
  }

  const TYPE_ICONS: Record<string, string> = {
    extension: '🔧', agent: '🤖', flow: '⬡', theme: '🎨', template: '📄',
  };

  const STATUS_VARIANT: Record<string, string> = {
    available: 'low', installed: 'medium', active: 'done', disabled: 'high',
  };
</script>

<ViewHeader title="Marketplace" sub="Browse, install and manage extensions, agents, flows, themes & templates" />

<div class="legacy-banner anim">
  <span class="legacy-icon">ⓘ</span>
  <div class="legacy-text">
    <strong>Superseded by Extensions.</strong>
    This page catalogs legacy marketplace items. All new installs &amp; admin
    (upload bundles, enable/disable, uninstall) happen in
    <a href="/extensions">/extensions</a>, the unified registry.
  </div>
  <button class="legacy-cta" on:click={() => goto('/extensions')}>Go to Extensions →</button>
</div>

{#if !mp}
  <Panel cls="anim"><Empty message="Loading marketplace..." /></Panel>
{:else}
  <!-- Stats bar -->
  <div class="mp-stats">
    <div class="mp-stat"><span class="mp-stat-val">{stats.total}</span><span class="mp-stat-lbl">Total</span></div>
    <div class="mp-stat"><span class="mp-stat-val">{stats.installed}</span><span class="mp-stat-lbl">Installed</span></div>
    <div class="mp-stat"><span class="mp-stat-val">{stats.active}</span><span class="mp-stat-lbl">Active</span></div>
    {#each Object.entries(stats.byType ?? {}) as [type, count]}
      <div class="mp-stat"><span class="mp-stat-val">{count}</span><span class="mp-stat-lbl">{type}</span></div>
    {/each}
  </div>

  <!-- Tabs -->
  <div class="mp-tabs">
    {#each TABS as tab}
      <button
        class="mp-tab"
        class:active={activeTab === tab.id}
        on:click={() => { activeTab = tab.id; cancelPreview(); }}
      >
        <span>{tab.icon}</span>
        <span>{tab.label}</span>
        <span class="mp-tab-count">{typeCounts[tab.id] ?? 0}</span>
      </button>
    {/each}
  </div>

  <!-- Search -->
  <div class="search-input-row" style="margin-bottom:16px">
    <input class="search-input" bind:value={search} placeholder="Search by name, description, or tags..." />
  </div>

  <!-- Theme Picker (when themes tab) -->
  {#if activeTab === 'theme' && themes.length > 0}
    <div class="mp-theme-picker">
      <div class="section-label">Theme Picker</div>
      <div class="mp-theme-grid">
        {#each themes as theme}
          {@const isActive = theme.active === 1}
          {@const isPreviewing = previewingThemeId === theme.item_id}
          {@const colors = JSON.parse(theme.preview_colors ?? '[]')}
          <button
            class="mp-theme-card"
            class:active={isActive}
            class:previewing={isPreviewing}
            on:click={() => previewTheme(theme)}
          >
            <div class="mp-theme-swatches">
              {#each colors as color}
                <div class="mp-swatch" style="background:{color}"></div>
              {/each}
            </div>
            <div class="mp-theme-name">
              {theme.icon} {theme.name}
              {#if isActive}<Badge text="Active" variant="done" />{/if}
            </div>
            <div class="mp-theme-actions">
              {#if isPreviewing}
                <button class="search-btn mp-btn-sm" on:click|stopPropagation={() => doAction(theme.item_id, 'activate-theme')}>
                  Apply
                </button>
                <button class="header-btn mp-btn-sm" on:click|stopPropagation={cancelPreview}>
                  Cancel
                </button>
              {:else if isActive}
                <button class="header-btn mp-btn-sm" on:click|stopPropagation={() => doAction(theme.item_id, 'deactivate-theme')}>
                  Reset
                </button>
              {:else}
                <button class="header-btn mp-btn-sm" on:click|stopPropagation={() => previewTheme(theme)}>
                  Preview
                </button>
              {/if}
            </div>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Items -->
  {#if totalFiltered === 0}
    <Panel cls="anim"><Empty message="No items found" /></Panel>
  {:else}

    <!-- ═══ INSTALLED SECTION ═══ -->
    {#if filteredInstalled.length > 0}
      <div class="mp-section">
        <div class="mp-section-header mp-section-installed">
          <span class="mp-section-icon">✓</span>
          <span class="mp-section-title">Installed</span>
          <span class="mp-section-count">{filteredInstalled.length}</span>
        </div>
        <div class="mp-grid">
          {#each filteredInstalled as item}
            {@const tags = parseTags(item.tags)}
            <div class="mp-card mp-card-installed" class:mp-card-active={item.status === 'active'} class:mp-card-disabled={item.status === 'disabled'}>
              <!-- Status indicator -->
              <div class="mp-installed-indicator">
                {#if item.status === 'active'}
                  <span class="mp-status-dot mp-dot-active"></span> Active
                {:else if item.status === 'disabled'}
                  <span class="mp-status-dot mp-dot-disabled"></span> Disabled
                {:else}
                  <span class="mp-status-dot mp-dot-installed"></span> Installed
                {/if}
              </div>

              <!-- Header -->
              <div class="mp-card-header">
                <span class="mp-card-icon">{item.icon || TYPE_ICONS[item.type] || '📦'}</span>
                <div class="mp-card-title-row">
                  <span class="mp-card-name">{item.name}</span>
                  <span class="mp-card-version">v{item.version}</span>
                </div>
              </div>

              <!-- Badges -->
              <div class="mp-card-badges">
                <Badge text={item.type} variant="low" />
                {#if item.verified}<Badge text="Verified" variant="done" />{/if}
              </div>

              <!-- Description -->
              <div class="mp-card-desc">{item.description}</div>

              <!-- Tags -->
              {#if tags.length > 0}
                <div class="mp-card-tags">
                  {#each tags.slice(0, 5) as tag}
                    <span class="badge badge-teal" style="font-size:9px">{tag}</span>
                  {/each}
                </div>
              {/if}

              <!-- Theme swatch -->
              {#if item.type === 'theme'}
                {@const themeRow = themes.find(t => t.item_id === item.id)}
                {#if themeRow}
                  {@const previewColors = JSON.parse(themeRow.preview_colors ?? '[]')}
                  <div class="mp-swatch-strip">
                    {#each previewColors as color}
                      <div class="mp-swatch-mini" style="background:{color}"></div>
                    {/each}
                  </div>
                {/if}
              {/if}

              <!-- Actions -->
              <div class="mp-card-actions">
                {#if item.status === 'installed'}
                  <button class="mp-btn-primary" disabled={loadingId === item.id}
                    on:click={() => doAction(item.id, 'enable')}>
                    ▶ Enable
                  </button>
                  <button class="mp-btn-ghost mp-btn-danger"
                    on:click={() => doAction(item.id, 'uninstall')}>
                    Uninstall
                  </button>
                {:else if item.status === 'active'}
                  <button class="mp-btn-ghost mp-btn-warn"
                    on:click={() => doAction(item.id, 'disable')}>
                    Pause
                  </button>
                  {#if item.type === 'theme'}
                    <button class="mp-btn-ghost"
                      on:click={() => doAction(item.id, 'deactivate-theme')}>
                      Reset Theme
                    </button>
                  {/if}
                {:else if item.status === 'disabled'}
                  <button class="mp-btn-primary" disabled={loadingId === item.id}
                    on:click={() => doAction(item.id, 'enable')}>
                    ▶ Enable
                  </button>
                  <button class="mp-btn-ghost mp-btn-danger"
                    on:click={() => doAction(item.id, 'uninstall')}>
                    Uninstall
                  </button>
                {/if}
                <button class="mp-btn-ghost" on:click={() => doExport(item.id, item.name)}>
                  ↗ Export
                </button>
              </div>

              <!-- Action message -->
              {#if actionMsg[item.id]?.text}
                <div class="mp-action-msg" class:ok={actionMsg[item.id].ok} class:err={!actionMsg[item.id].ok}>
                  {actionMsg[item.id].text}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ═══ AVAILABLE / MARKETPLACE SECTION ═══ -->
    {#if filteredAvailable.length > 0}
      <div class="mp-section">
        <div class="mp-section-header mp-section-available">
          <span class="mp-section-icon">↓</span>
          <span class="mp-section-title">Available in Marketplace</span>
          <span class="mp-section-count">{filteredAvailable.length}</span>
        </div>
        <div class="mp-grid">
          {#each filteredAvailable as item}
            {@const tags = parseTags(item.tags)}
            <div class="mp-card mp-card-available">
              <!-- Header -->
              <div class="mp-card-header">
                <span class="mp-card-icon">{item.icon || TYPE_ICONS[item.type] || '📦'}</span>
                <div class="mp-card-title-row">
                  <span class="mp-card-name">{item.name}</span>
                  <span class="mp-card-version">v{item.version}</span>
                </div>
              </div>

              <!-- Badges -->
              <div class="mp-card-badges">
                <Badge text={item.type} variant="low" />
                {#if item.verified}<Badge text="Verified" variant="done" />{/if}
                {#if item.featured}<Badge text="Featured" variant="medium" />{/if}
                <span class="mp-price-tag">{fmtPrice(item.price_cents, item.currency)}</span>
              </div>

              <!-- Description -->
              <div class="mp-card-desc">{item.description}</div>

              <!-- Meta row -->
              <div class="mp-card-meta">
                {#if item.avg_rating > 0}
                  <span class="mp-stars">{stars(item.avg_rating)} ({item.review_count})</span>
                {/if}
                <span>{item.install_count} installs</span>
                <span>by {item.author}</span>
              </div>

              <!-- Tags -->
              {#if tags.length > 0}
                <div class="mp-card-tags">
                  {#each tags.slice(0, 5) as tag}
                    <span class="badge badge-teal" style="font-size:9px">{tag}</span>
                  {/each}
                </div>
              {/if}

              <!-- Theme swatch -->
              {#if item.type === 'theme'}
                {@const themeRow = themes.find(t => t.item_id === item.id)}
                {#if themeRow}
                  {@const previewColors = JSON.parse(themeRow.preview_colors ?? '[]')}
                  <div class="mp-swatch-strip">
                    {#each previewColors as color}
                      <div class="mp-swatch-mini" style="background:{color}"></div>
                    {/each}
                  </div>
                {/if}
              {/if}

              <!-- Actions -->
              <div class="mp-card-actions">
                <button class="mp-btn-install" disabled={loadingId === item.id}
                  on:click={() => doAction(item.id, 'install')}>
                  {loadingId === item.id ? 'Installing...' : '↓ Install'}
                </button>
                <button class="mp-btn-ghost" on:click={() => doExport(item.id, item.name)}>
                  ↗ Export
                </button>
              </div>

              <!-- Action message -->
              {#if actionMsg[item.id]?.text}
                <div class="mp-action-msg" class:ok={actionMsg[item.id].ok} class:err={!actionMsg[item.id].ok}>
                  {actionMsg[item.id].text}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
{/if}

<style>
  /* ── Legacy banner ──────────────────────── */
  .legacy-banner {
    display: flex; align-items: center; gap: 12px;
    background: color-mix(in srgb, var(--amber) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent);
    border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;
    font-size: 13px; color: var(--text-1);
  }
  .legacy-icon { font-size: 18px; color: var(--amber); }
  .legacy-text { flex: 1; line-height: 1.45; }
  .legacy-text a { color: var(--blue); text-decoration: underline; }
  .legacy-cta {
    background: var(--blue); color: var(--bg-1); border: none;
    border-radius: 6px; padding: 6px 12px; font-weight: 600;
    cursor: pointer; white-space: nowrap;
  }
  .legacy-cta:hover { opacity: .9; }

  /* ── Stats bar ──────────────────────────── */
  .mp-stats {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .mp-stat {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .mp-stat-val {
    font-size: 18px;
    font-weight: 700;
    color: var(--gold);
  }
  .mp-stat-lbl {
    font-size: 10px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* ── Tabs ────────────────────────────────── */
  .mp-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .mp-tab {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    font-size: 12px;
    color: var(--text-2);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .mp-tab:hover { border-color: var(--border-h); color: var(--text-1); }
  .mp-tab.active {
    background: var(--surface-3);
    border-color: var(--gold);
    color: var(--gold);
  }
  .mp-tab-count {
    background: var(--surface-1);
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
    color: var(--text-3);
  }
  .mp-tab.active .mp-tab-count { color: var(--gold); }

  /* ── Section headers ─────────────────────── */
  .mp-section {
    margin-bottom: 28px;
  }
  .mp-section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .mp-section-icon {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
  }
  .mp-section-installed .mp-section-icon {
    background: rgba(61, 214, 140, 0.15);
    color: var(--green);
  }
  .mp-section-available .mp-section-icon {
    background: rgba(var(--gold-rgb, 212, 175, 55), 0.15);
    color: var(--gold);
  }
  .mp-section-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-1);
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }
  .mp-section-count {
    font-size: 11px;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 1px 8px;
    border-radius: 8px;
  }

  /* ── Grid ─────────────────────────────────── */
  .mp-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
  }

  /* ── Base card ────────────────────────────── */
  .mp-card {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: all 0.2s;
    position: relative;
  }

  /* ── Installed card — prominent look ──────── */
  .mp-card-installed {
    border-left: 3px solid var(--green);
    background: var(--surface-2);
  }
  .mp-card-installed:hover {
    border-color: var(--green);
    border-left-color: var(--green);
  }
  .mp-card-active {
    border-left-color: var(--green);
    background: linear-gradient(135deg, var(--surface-2), rgba(61, 214, 140, 0.04));
  }
  .mp-card-disabled {
    border-left-color: var(--text-3);
    opacity: 0.7;
  }
  .mp-card-disabled:hover { opacity: 1; }

  /* ── Available card — subtle marketplace look ─ */
  .mp-card-available {
    border: 1px dashed var(--border);
    background: var(--surface-1);
  }
  .mp-card-available:hover {
    border-color: var(--gold);
    border-style: solid;
    background: var(--surface-2);
  }

  /* ── Status indicator (installed cards) ────── */
  .mp-installed-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-3);
  }
  .mp-status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
  }
  .mp-dot-active {
    background: var(--green);
    box-shadow: 0 0 6px rgba(61, 214, 140, 0.5);
  }
  .mp-dot-disabled { background: var(--text-3); }
  .mp-dot-installed { background: var(--teal); }

  /* ── Card parts ───────────────────────────── */
  .mp-card-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mp-card-icon {
    font-size: 24px;
    flex-shrink: 0;
  }
  .mp-card-title-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .mp-card-name {
    font-weight: 700;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mp-card-installed .mp-card-name { color: var(--text-1); }
  .mp-card-available .mp-card-name { color: var(--text-2); }
  .mp-card-available:hover .mp-card-name { color: var(--text-1); }

  .mp-card-version {
    font-size: 10px;
    color: var(--text-3);
    font-family: var(--font-mono);
  }

  .mp-card-badges {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    align-items: center;
  }

  .mp-price-tag {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 8px;
    border-radius: 8px;
    background: rgba(var(--gold-rgb, 212, 175, 55), 0.12);
    color: var(--gold);
    letter-spacing: 0.3px;
  }

  .mp-card-desc {
    font-size: 12px;
    color: var(--text-2);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .mp-card-meta {
    font-size: 11px;
    color: var(--text-3);
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: center;
  }
  .mp-stars { color: var(--gold); }

  .mp-card-tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .mp-card-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: auto;
    padding-top: 8px;
  }

  /* ── Buttons ──────────────────────────────── */
  .mp-btn-install {
    background: var(--gold);
    color: var(--bg);
    border: none;
    border-radius: var(--radius-sm);
    padding: 6px 16px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
  }
  .mp-btn-install:hover { filter: brightness(1.1); }
  .mp-btn-install:disabled { opacity: 0.5; cursor: default; }

  .mp-btn-primary {
    background: var(--green);
    color: var(--bg);
    border: none;
    border-radius: var(--radius-sm);
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
  }
  .mp-btn-primary:hover { filter: brightness(1.1); }
  .mp-btn-primary:disabled { opacity: 0.5; cursor: default; }

  .mp-btn-ghost {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 5px 12px;
    font-size: 11px;
    color: var(--text-2);
    cursor: pointer;
    transition: all 0.15s;
  }
  .mp-btn-ghost:hover { border-color: var(--border-h); color: var(--text-1); }
  .mp-btn-warn { border-color: var(--orange); color: var(--orange); }
  .mp-btn-warn:hover { background: rgba(var(--orange-rgb, 234, 179, 8), 0.08); }
  .mp-btn-danger { border-color: transparent; color: var(--text-3); }
  .mp-btn-danger:hover { border-color: var(--red); color: var(--red); }

  .mp-btn-sm {
    padding: 3px 10px;
    font-size: 10px;
  }

  .mp-action-msg {
    font-size: 10px;
    padding: 2px 0;
  }
  .mp-action-msg.ok { color: var(--green); }
  .mp-action-msg.err { color: var(--red); }

  /* ── Swatches ─────────────────────────────── */
  .mp-swatch-strip {
    display: flex;
    gap: 2px;
    margin-top: 4px;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
  }
  .mp-swatch-mini {
    flex: 1;
    min-width: 0;
  }

  /* ── Theme picker ─────────────────────────── */
  .mp-theme-picker {
    margin-bottom: 20px;
  }
  .mp-theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
    margin-top: 8px;
  }
  .mp-theme-card {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mp-theme-card:hover { border-color: var(--border-h); }
  .mp-theme-card.active { border-color: var(--gold); }
  .mp-theme-card.previewing { border-color: var(--teal); box-shadow: 0 0 0 1px var(--teal); }

  .mp-theme-swatches {
    display: flex;
    gap: 3px;
    height: 24px;
    border-radius: 4px;
    overflow: hidden;
  }
  .mp-swatch {
    flex: 1;
    min-width: 0;
  }
  .mp-theme-name {
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mp-theme-actions {
    display: flex;
    gap: 4px;
  }
</style>
