<script lang="ts">
  import { files } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import { fmtTime } from '$lib/utils.js';

  function fmtBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  const catIcons: Record<string, string> = {
    document: '📄', image: '🖼️', code: '💻', media: '🎬',
    archive: '📦', data: '📊', config: '⚙️', other: '📎'
  };
  const catColors: Record<string, string> = {
    document: 'var(--blue)', image: 'var(--purple)', code: 'var(--green)',
    media: 'var(--orange)', archive: 'var(--gold)', data: 'var(--teal)',
    config: 'var(--text-3)', other: 'var(--text-2)'
  };
  const catLabels: Record<string, string> = {
    document: 'Documents', image: 'Images', code: 'Source Code', media: 'Media',
    archive: 'Archives', data: 'Data Files', config: 'Config', other: 'Other'
  };
  const sizeLabels: Record<string, string> = {
    tiny: '< 1 KB', small: '1 KB – 1 MB', medium: '1 – 10 MB', large: '10 – 100 MB', huge: '> 100 MB'
  };
  const sizeRangeParams: Record<string, { min?: number; max?: number }> = {
    tiny: { max: 1024 }, small: { min: 1024, max: 1048576 },
    medium: { min: 1048576, max: 10485760 }, large: { min: 10485760, max: 104857600 },
    huge: { min: 104857600 }
  };

  // ── State ──────────────────────────────────────
  type Tab = 'overview' | 'browse' | 'search' | 'organize';
  let tab: Tab = 'overview';

  // Add form
  let showAddForm = false;
  let formLabel = ''; let formPath = ''; let formInclude = '';
  let formExclude = 'node_modules,.git,.cache,__pycache__,.DS_Store,thumbs.db';
  let formScanContent = true;
  let adding = false;
  let scanning: Record<string, boolean> = {};

  // Browse state
  let browseFiles: any[] = [];
  let browseTotal = 0;
  let browsePage = 1;
  let browsePerPage = 50;
  let browseLoading = false;
  let filterCat = '';
  let filterExt = '';
  let filterSize = '';
  let filterSearch = '';
  let browseSort = 'date';
  let browseSortDir = 'desc';
  let filterData: any = null;

  // Search state
  let searchQuery = '';
  let searchResults: any[] = [];
  let searching = false;
  let searchDone = false;

  // Organize state
  let virtualTree: any[] = [];
  let organizing = false;
  let generatingEmbeddings = false;
  let treeLoaded = false;
  let expandedFolders: Record<string, boolean> = {};

  // ── Derived ────────────────────────────────────
  $: fd = ($files as any);
  $: byCategory = (fd?.byCategory ?? []) as any[];
  $: topExtensions = (fd?.topExtensions ?? []) as any[];
  $: recentFiles = (fd?.recentFiles ?? []) as any[];
  $: largestFiles = (fd?.largestFiles ?? []) as any[];
  $: scanConfigs = (fd?.scanConfigs ?? []) as any[];
  $: totalSize = fd?.totalSizeBytes ?? 0;
  $: maxCatSize = Math.max(...byCategory.map((c: any) => c.sizeBytes), 1);
  $: hasData = fd && fd.totalFiles > 0;
  $: dupWaste = fd?.duplicateWasteBytes ?? 0;
  $: dupGroups = fd?.duplicateGroups ?? 0;
  $: browsePages = Math.ceil(browseTotal / browsePerPage);

  // ── API helpers ────────────────────────────────
  function urlToRpcAction(url: string, method: string): string | null {
    const u = url.split('?')[0];
    const actionMap: Record<string, string> = {
      '/api/dashboard/files': 'dashboard.files',
      '/api/files/add-scan': 'files.addScan',
      '/api/files/scan': 'files.scan',
      '/api/files/browse': 'files.browse',
      '/api/files/filters': 'files.filters',
      '/api/files/search': 'files.search',
      '/api/files/generate-embeddings': 'files.generateEmbeddings',
      '/api/files/reorganize': 'files.reorganize',
      '/api/files/virtual-tree': 'files.virtualTree',
    };
    return actionMap[u] ?? null;
  }

  function urlArgs(url: string, opts?: RequestInit): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      for (const [k, v] of new URLSearchParams(url.slice(qIdx + 1))) args[k] = v;
    }
    if (opts?.body) {
      try { Object.assign(args, JSON.parse(opts.body as string)); } catch {}
    }
    return args;
  }

  async function safeFetch(url: string, opts?: RequestInit) {
    const method = opts?.method ?? 'GET';
    const action = urlToRpcAction(url, method);
    const args = urlArgs(url, opts);
    if (action) {
      try {
        return await rpcOrCall(action, args, async () => {
          const r = await fetch(url, opts);
          if (!r.ok) return null;
          return r.json();
        });
      } catch { return null; }
    }
    try {
      const r = await fetch(url, opts);
      if (!r.ok) return null;
      return r.json();
    } catch { return null; }
  }

  function post(url: string, body: unknown) {
    return safeFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function refreshFiles() {
    const data = await safeFetch('/api/dashboard/files');
    if (data) files.set(data);
  }

  // ── Add / Scan ─────────────────────────────────
  async function addScanConfig() {
    if (!formLabel.trim() || !formPath.trim()) return;
    adding = true;
    try {
      const res = await post('/api/files/add-scan', {
        label: formLabel.trim(), base_path: formPath.trim(),
        include_patterns: formInclude.trim(), exclude_patterns: formExclude.trim(),
        scan_content: formScanContent,
      });
      if (res?.ok) {
        showAddForm = false;
        formLabel = ''; formPath = ''; formInclude = '';
        formExclude = 'node_modules,.git,.cache,__pycache__,.DS_Store,thumbs.db';
        formScanContent = true;
        await runScan(res.id);
      }
    } finally { adding = false; }
  }

  async function runScan(configId: string) {
    scanning = { ...scanning, [configId]: true };
    try {
      await post('/api/files/scan', { config_id: configId });
      await refreshFiles();
    } finally { scanning = { ...scanning, [configId]: false }; }
  }

  // ── Browse ─────────────────────────────────────
  async function loadBrowse(resetPage = true) {
    if (resetPage) browsePage = 1;
    browseLoading = true;
    try {
      const params = new URLSearchParams();
      params.set('page', String(browsePage));
      params.set('per_page', String(browsePerPage));
      params.set('sort', browseSort);
      params.set('sort_dir', browseSortDir);
      if (filterCat) params.set('category', filterCat);
      if (filterExt) params.set('extension', filterExt);
      if (filterSearch) params.set('search', filterSearch);
      if (filterSize) {
        const r = sizeRangeParams[filterSize];
        if (r?.min) params.set('min_size', String(r.min));
        if (r?.max) params.set('max_size', String(r.max));
      }
      const data = await safeFetch(`/api/files/browse?${params}`);
      if (data) { browseFiles = data.files ?? []; browseTotal = data.total ?? 0; }
    } finally { browseLoading = false; }
  }

  async function loadFilters() {
    filterData = await safeFetch('/api/files/filters');
  }

  function switchToBrowseWithCategory(cat: string) {
    tab = 'browse';
    filterCat = cat;
    filterExt = ''; filterSize = ''; filterSearch = '';
    loadFilters();
    loadBrowse();
  }

  function switchToBrowseWithExtension(ext: string) {
    tab = 'browse';
    filterExt = ext;
    filterCat = ''; filterSize = ''; filterSearch = '';
    loadFilters();
    loadBrowse();
  }

  // ── Search ─────────────────────────────────────
  async function runSearch() {
    if (!searchQuery.trim()) return;
    searching = true; searchDone = false;
    try {
      const data = await post('/api/files/search', { query: searchQuery.trim(), limit: 30 });
      searchResults = data?.results ?? [];
      searchDone = true;
    } finally { searching = false; }
  }

  // ── Organize ───────────────────────────────────
  async function generateEmbeddings() {
    generatingEmbeddings = true;
    try {
      await post('/api/files/generate-embeddings', {});
    } finally { generatingEmbeddings = false; }
  }

  async function runReorganize() {
    organizing = true;
    try {
      await post('/api/files/reorganize', {});
      await loadVirtualTree();
    } finally { organizing = false; }
  }

  async function loadVirtualTree() {
    const data = await safeFetch('/api/files/virtual-tree');
    virtualTree = data?.tree ?? [];
    treeLoaded = true;
    // Auto-expand top level
    for (const f of virtualTree.filter((n: any) => n.level === 0)) {
      expandedFolders[f.path] = true;
    }
    expandedFolders = expandedFolders;
  }

  function toggleFolder(path: string) {
    expandedFolders[path] = !expandedFolders[path];
    expandedFolders = expandedFolders;
  }

  // ── Tab init ───────────────────────────────────
  $: if (tab === 'browse' && browseFiles.length === 0 && !browseLoading && hasData) {
    loadFilters();
    loadBrowse();
  }
  $: if (tab === 'organize' && !treeLoaded && hasData) {
    loadVirtualTree();
  }
</script>

<script lang="ts" context="module">
  import { hostPathSep, splitHostPath } from '$lib/host-path.js';

  // Separator-aware: a native Windows kernel indexes C:\Users\… paths, which a
  // "/" split left as one untouched, very long segment.
  function shortenPath(path: string): string {
    if (!path) return '';
    const { root, parts } = splitHostPath(path);
    if (parts.length <= 3) return path;
    const sep = hostPathSep(path);
    return root + parts[0] + sep + '...' + sep + parts.slice(-2).join(sep);
  }
  function shortenDir(dir: string): string {
    if (!dir) return '';
    const { parts } = splitHostPath(dir);
    if (parts.length <= 2) return dir;
    const sep = hostPathSep(dir);
    return '...' + sep + parts.slice(-2).join(sep);
  }
</script>

<ViewHeader title="Local Files" sub="File intelligence & organization" />

<!-- ── Add Directory Form ──────────────────────── -->
{#if showAddForm}
  <div class="add-form anim">
    <div class="add-form-header">
      <span class="add-form-title">Add Directory to Index</span>
      <button class="btn-ghost" on:click={() => showAddForm = false}>Cancel</button>
    </div>
    <div class="form-row">
      <div class="form-field">
        <label for="f-label">Label</label>
        <input id="f-label" type="text" bind:value={formLabel} placeholder="e.g. Home Documents" />
      </div>
      <div class="form-field grow">
        <label for="f-path">Directory Path</label>
        <input id="f-path" type="text" bind:value={formPath} placeholder="/home/user/Documents or C:\Users\you\Documents" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-field">
        <label for="f-include">Include <span class="hint">(optional)</span></label>
        <input id="f-include" type="text" bind:value={formInclude} placeholder="*.pdf,*.docx" />
      </div>
      <div class="form-field">
        <label for="f-exclude">Exclude</label>
        <input id="f-exclude" type="text" bind:value={formExclude} />
      </div>
      <div class="form-field cb">
        <label><input type="checkbox" bind:checked={formScanContent} /> Content</label>
      </div>
    </div>
    <button class="btn-primary" on:click={addScanConfig} disabled={adding || !formLabel.trim() || !formPath.trim()}>
      {adding ? 'Adding & scanning...' : 'Add & Scan'}
    </button>
  </div>
{/if}

{#if !fd}
  <div class="loading-view">File indexer backend is not available in this build.</div>

{:else if !hasData}
  <div class="onboarding anim">
    <div class="onboarding-hero">
      <div class="hero-icon">📂</div>
      <h2 class="hero-title">Index your files to get started</h2>
      <p class="hero-sub">Scan directories to build a searchable index with duplicate detection, semantic search, and AI-powered virtual reorganization.</p>
      <button class="btn-primary mt12" on:click={() => showAddForm = true}>+ Add Directory</button>
    </div>
    {#if scanConfigs.length > 0}
      <Panel title="Pending Scans" dotColor="var(--gold)" cls="anim d2">
        {#each scanConfigs as sc}
          <div class="scan-card row">
            <span class="scan-label">{sc.label}</span>
            <span class="scan-path-inline">{sc.base_path}</span>
            <button class="btn-scan" on:click={() => runScan(sc.id)} disabled={scanning[sc.id]}>
              {scanning[sc.id] ? 'Scanning...' : 'Scan'}
            </button>
          </div>
        {/each}
      </Panel>
    {/if}
  </div>

{:else}
  <!-- ── Tab Bar ──────────────────────────────────── -->
  <div class="tab-bar anim">
    <div class="tabs-left">
      <button class="tab" class:active={tab === 'overview'} on:click={() => tab = 'overview'}>Overview</button>
      <button class="tab" class:active={tab === 'browse'} on:click={() => tab = 'browse'}>Browse</button>
      <button class="tab" class:active={tab === 'search'} on:click={() => tab = 'search'}>Search</button>
      <button class="tab" class:active={tab === 'organize'} on:click={() => tab = 'organize'}>Organize</button>
    </div>
    <div class="tabs-right">
      <button class="btn-primary btn-sm" on:click={() => showAddForm = true}>+ Add Directory</button>
    </div>
  </div>

  <!-- ═══════════════ OVERVIEW TAB ═══════════════ -->
  {#if tab === 'overview'}
    <div class="kpi-row anim">
      <KpiCard label="Total Files" value={fd.totalFiles.toLocaleString()} accent="--blue" color="var(--blue)" />
      <KpiCard label="Total Size" value={fmtBytes(totalSize)} accent="--purple" color="var(--purple)" />
      <KpiCard label="Categories" value={byCategory.length} accent="--teal" color="var(--teal)" />
      <KpiCard label="Duplicates" value={dupGroups} accent="--orange" color={dupGroups > 0 ? 'var(--orange)' : 'var(--text-1)'} />
      <KpiCard label="Wasted" value={fmtBytes(dupWaste)} accent="--red" color={dupWaste > 0 ? 'var(--red)' : 'var(--text-1)'} />
      <KpiCard label="Scans" value={scanConfigs.length} accent="--green" color="var(--green)" />
    </div>

    {#if byCategory.length}
      <Panel title="Storage by Category" dotColor="var(--blue)" cls="anim d2">
        <div class="cat-grid">
          {#each byCategory as cat}
            <button class="cat-row clickable" on:click={() => switchToBrowseWithCategory(cat.category)}>
              <div class="cat-label">
                <span class="cat-icon">{catIcons[cat.category] ?? '📎'}</span>
                <span class="cat-name">{catLabels[cat.category] ?? cat.category}</span>
              </div>
              <div class="cat-bar-wrap">
                <div class="cat-bar" style="width:{Math.max((cat.sizeBytes / maxCatSize) * 100, 3)}%;background:{catColors[cat.category] ?? 'var(--text-3)'}">
                  <span class="cat-bar-label">{cat.count.toLocaleString()}</span>
                </div>
              </div>
              <span class="cat-size">{fmtBytes(cat.sizeBytes)}</span>
            </button>
          {/each}
        </div>
      </Panel>
    {/if}

    <div class="two-col anim d3">
      {#if topExtensions.length}
        <Panel title="Top File Types" dotColor="var(--teal)">
          <div class="ext-list">
            {#each topExtensions.slice(0, 10) as ext, i}
              <button class="ext-row clickable" on:click={() => switchToBrowseWithExtension(ext.extension)}>
                <span class="ext-rank">#{i + 1}</span>
                <span class="ext-name">.{ext.extension}</span>
                <div class="ext-bar-wrap"><div class="ext-bar" style="width:{Math.max((ext.count / (topExtensions[0]?.count || 1)) * 100, 4)}%"></div></div>
                <span class="ext-count">{ext.count.toLocaleString()}</span>
                <span class="ext-size">{fmtBytes(ext.sizeBytes)}</span>
              </button>
            {/each}
          </div>
        </Panel>
      {/if}

      {#if largestFiles.length}
        <Panel title="Largest Files" dotColor="var(--red)">
          {#each largestFiles.slice(0, 8) as f, i}
            <div class="file-row">
              <span class="file-rank" style="color:var(--red)">{i + 1}</span>
              <div class="file-info">
                <div class="file-name" title={f.path}>{f.name}</div>
                <div class="file-path">{shortenPath(f.path)}</div>
              </div>
              <span class="file-size" style="color:var(--red)">{fmtBytes(f.size_bytes)}</span>
            </div>
          {/each}
        </Panel>
      {/if}
    </div>

    {#if scanConfigs.length}
      <Panel title="Scan Configurations" dotColor="var(--text-3)" cls="anim d4">
        <div class="scan-grid">
          {#each scanConfigs as sc}
            <div class="scan-card">
              <div class="scan-card-header">
                <span class="scan-card-icon">📁</span>
                <span class="scan-label">{sc.label}</span>
                <button class="btn-scan sm" on:click={() => runScan(sc.id)} disabled={scanning[sc.id]}>{scanning[sc.id] ? '...' : 'Re-scan'}</button>
              </div>
              <div class="scan-path">{sc.base_path}</div>
              <div class="scan-status">
                {#if sc.last_scan_at}<span class="scan-dot active"></span> {fmtTime(sc.last_scan_at)}
                {:else}<span class="scan-dot pending"></span> Never scanned{/if}
              </div>
            </div>
          {/each}
        </div>
      </Panel>
    {/if}

    {#if dupGroups > 0}
      <div class="dup-banner anim d5">
        <span class="dup-icon">🔄</span>
        <div class="dup-text">
          <strong>{dupGroups} duplicate group{dupGroups > 1 ? 's' : ''}</strong>
          <span>Free up <strong>{fmtBytes(dupWaste)}</strong> by removing duplicates.</span>
        </div>
      </div>
    {/if}

  <!-- ═══════════════ BROWSE TAB ═══════════════ -->
  {:else if tab === 'browse'}
    <div class="browse-layout anim">
      <!-- Sidebar -->
      <div class="browse-sidebar">
        <!-- Text filter -->
        <div class="sidebar-section">
          <input class="search-input" bind:value={filterSearch} placeholder="Filter by name..." on:keypress={e => { if (e.key === 'Enter') loadBrowse(); }} />
        </div>

        <!-- Categories -->
        <div class="sidebar-section">
          <div class="sidebar-title">Category</div>
          <div class="filter-pills">
            <button class="pill" class:on={!filterCat} on:click={() => { filterCat = ''; loadBrowse(); }}>All</button>
            {#each (filterData?.categories ?? byCategory) as c}
              <button class="pill" class:on={filterCat === (c.category ?? c)} on:click={() => { filterCat = c.category ?? c; loadBrowse(); }}>
                {catIcons[c.category ?? c] ?? ''} {catLabels[c.category ?? c] ?? c.category ?? c}
                {#if c.count}<span class="pill-cnt">{c.count}</span>{/if}
              </button>
            {/each}
          </div>
        </div>

        <!-- Size ranges -->
        <div class="sidebar-section">
          <div class="sidebar-title">Size</div>
          <div class="filter-pills">
            <button class="pill" class:on={!filterSize} on:click={() => { filterSize = ''; loadBrowse(); }}>All</button>
            {#each Object.entries(sizeLabels) as [key, label]}
              <button class="pill" class:on={filterSize === key} on:click={() => { filterSize = key; loadBrowse(); }}>
                {label}
                {#if filterData?.sizeRanges?.[key]}<span class="pill-cnt">{filterData.sizeRanges[key]}</span>{/if}
              </button>
            {/each}
          </div>
        </div>

        <!-- Extensions -->
        <div class="sidebar-section">
          <div class="sidebar-title">Extension</div>
          <div class="filter-pills ext-pills">
            <button class="pill sm" class:on={!filterExt} on:click={() => { filterExt = ''; loadBrowse(); }}>All</button>
            {#each (filterData?.extensions ?? []).slice(0, 20) as e}
              <button class="pill sm" class:on={filterExt === e.extension} on:click={() => { filterExt = e.extension; loadBrowse(); }}>
                .{e.extension} <span class="pill-cnt">{e.count}</span>
              </button>
            {/each}
          </div>
        </div>

        <!-- Sort -->
        <div class="sidebar-section">
          <div class="sidebar-title">Sort</div>
          <div class="sort-row">
            <select class="nf-select" bind:value={browseSort} on:change={() => loadBrowse()}>
              <option value="date">Date</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="extension">Extension</option>
            </select>
            <button class="sort-dir" on:click={() => { browseSortDir = browseSortDir === 'desc' ? 'asc' : 'desc'; loadBrowse(); }}>
              {browseSortDir === 'desc' ? '↓' : '↑'}
            </button>
          </div>
        </div>
      </div>

      <!-- File List -->
      <div class="browse-main">
        <div class="browse-header">
          <span class="browse-count">{browseTotal.toLocaleString()} files</span>
          {#if browseLoading}<span class="browse-loading">Loading...</span>{/if}
        </div>

        {#if browseFiles.length === 0 && !browseLoading}
          <div class="empty-state">No files match the current filters</div>
        {:else}
          <div class="browse-list">
            {#each browseFiles as f}
              <div class="browse-file">
                <span class="bf-icon">{catIcons[f.category] ?? '📎'}</span>
                <div class="bf-info">
                  <div class="bf-name" title={f.path}>{f.name}</div>
                  <div class="bf-meta">
                    <Badge text={f.extension ? `.${f.extension}` : f.category} />
                    <span class="meta-sep">·</span>
                    <span>{fmtBytes(f.size_bytes)}</span>
                    <span class="meta-sep">·</span>
                    <span>{shortenDir(f.parent_dir)}</span>
                    {#if f.file_modified_at}
                      <span class="meta-sep">·</span>
                      <span>{fmtTime(f.file_modified_at)}</span>
                    {/if}
                  </div>
                  {#if f.snippet}
                    <div class="bf-snippet">{f.snippet.slice(0, 120)}...</div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          <!-- Pagination -->
          {#if browsePages > 1}
            <div class="pagination">
              <button class="page-btn" disabled={browsePage <= 1} on:click={() => { browsePage--; loadBrowse(false); }}>Prev</button>
              <span class="page-info">Page {browsePage} / {browsePages}</span>
              <button class="page-btn" disabled={browsePage >= browsePages} on:click={() => { browsePage++; loadBrowse(false); }}>Next</button>
            </div>
          {/if}
        {/if}
      </div>
    </div>

  <!-- ═══════════════ SEARCH TAB ═══════════════ -->
  {:else if tab === 'search'}
    <div class="search-section anim">
      <Panel title="Semantic File Search" dotColor="var(--purple)" cls="anim">
        <p class="search-hint">Search by meaning — finds files based on content similarity using AI embeddings and Neo4j vector search.</p>
        <div class="search-input-row">
          <input class="search-input" bind:value={searchQuery} placeholder="e.g. 'tax documents 2024', 'python machine learning', 'invoice PDF'..." on:keypress={e => { if (e.key === 'Enter') runSearch(); }} />
          <button class="search-btn" on:click={runSearch} disabled={searching || !searchQuery.trim()}>
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </Panel>

      {#if searchDone && searchResults.length === 0}
        <div class="empty-state">No results found. Try generating embeddings first from the Organize tab.</div>
      {/if}

      {#if searchResults.length > 0}
        <Panel title="Results ({searchResults.length})" dotColor="var(--green)" cls="anim d2">
          {#each searchResults as r, i}
            <div class="search-result">
              <div class="sr-rank">{i + 1}</div>
              <span class="sr-icon">{catIcons[r.category] ?? '📎'}</span>
              <div class="sr-info">
                <div class="sr-name">{r.name}</div>
                <div class="sr-meta">
                  <Badge text={r.category} />
                  {#if r.extension}<Badge text={`.${r.extension}`} variant="teal" />{/if}
                  <span class="meta-sep">·</span>
                  <span>{fmtBytes(r.size_bytes)}</span>
                  <span class="meta-sep">·</span>
                  <span class="sr-path">{shortenPath(r.path)}</span>
                </div>
                {#if r.snippet}
                  <div class="sr-snippet">{r.snippet.slice(0, 200)}</div>
                {/if}
              </div>
              <div class="sr-score" title="Similarity score">
                <div class="score-bar" style="height:{Math.round(r.score * 100)}%"></div>
                <span class="score-val">{(r.score * 100).toFixed(0)}%</span>
              </div>
            </div>
          {/each}
        </Panel>
      {/if}
    </div>

  <!-- ═══════════════ ORGANIZE TAB ═══════════════ -->
  {:else if tab === 'organize'}
    <div class="organize-section anim">
      <Panel title="Virtual Reorganization" dotColor="var(--gold)" cls="anim">
        <p class="org-hint">
          Generate an AI-powered virtual folder structure based on file categories, extensions, and content similarity.
          Files stay in their real locations — this is a proposed organization visible only in the graph.
        </p>
        <div class="org-actions">
          <button class="btn-primary" on:click={generateEmbeddings} disabled={generatingEmbeddings}>
            {generatingEmbeddings ? 'Generating embeddings...' : 'Generate Embeddings'}
          </button>
          <button class="btn-primary gold" on:click={runReorganize} disabled={organizing}>
            {organizing ? 'Reorganizing...' : 'Generate Virtual Structure'}
          </button>
          {#if treeLoaded}
            <button class="btn-ghost" on:click={loadVirtualTree}>Refresh Tree</button>
          {/if}
        </div>
      </Panel>

      {#if virtualTree.length > 0}
        <Panel title="Virtual Folder Structure" dotColor="var(--teal)" cls="anim d2">
          <div class="vtree">
            {#each virtualTree.filter(n => n.level === 0) as folder}
              <div class="vtree-folder">
                <button class="vtree-header" on:click={() => toggleFolder(folder.path)}>
                  <span class="vtree-arrow">{expandedFolders[folder.path] ? '▾' : '▸'}</span>
                  <span class="vtree-icon">{catIcons[folder.category] ?? '📁'}</span>
                  <span class="vtree-name">{folder.name}</span>
                  <span class="vtree-count">{folder.fileCount} files</span>
                  <span class="vtree-size">{fmtBytes(folder.totalSize)}</span>
                </button>

                {#if expandedFolders[folder.path]}
                  <!-- Sub-folders -->
                  {#each virtualTree.filter(n => n.level === 1 && n.path.startsWith(folder.path + '/')) as sub}
                    <div class="vtree-sub">
                      <button class="vtree-header sub" on:click={() => toggleFolder(sub.path)}>
                        <span class="vtree-arrow">{expandedFolders[sub.path] ? '▾' : '▸'}</span>
                        <span class="vtree-icon-sm">📂</span>
                        <span class="vtree-name">{sub.name}</span>
                        <span class="vtree-count">{sub.fileCount}</span>
                        <span class="vtree-size">{fmtBytes(sub.totalSize)}</span>
                      </button>

                      {#if expandedFolders[sub.path] && sub.files?.length}
                        <div class="vtree-files">
                          {#each sub.files as f}
                            <div class="vtree-file">
                              <span class="vtree-file-icon">{catIcons[folder.category] ?? '📎'}</span>
                              <span class="vtree-file-name" title={f.realPath}>{f.name}</span>
                              <span class="vtree-file-size">{fmtBytes(f.size_bytes)}</span>
                            </div>
                          {/each}
                          {#if sub.fileCount > sub.files.length}
                            <div class="vtree-more">... and {sub.fileCount - sub.files.length} more</div>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}

                  <!-- Direct files in category root -->
                  {#if folder.files?.length}
                    <div class="vtree-files indent">
                      {#each folder.files as f}
                        <div class="vtree-file">
                          <span class="vtree-file-icon">{catIcons[folder.category] ?? '📎'}</span>
                          <span class="vtree-file-name" title={f.realPath}>{f.name}</span>
                          <span class="vtree-file-size">{fmtBytes(f.size_bytes)}</span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        </Panel>
      {:else if treeLoaded}
        <div class="empty-state">No virtual structure yet. Click "Generate Virtual Structure" to create one.</div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  /* ── Tab Bar ──────────────────────────────────── */
  .tab-bar {
    display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid var(--border); margin-bottom: 20px; padding-bottom: 0;
  }
  .tabs-left { display: flex; gap: 0; }
  .tabs-right { padding-bottom: 8px; }
  .tab {
    padding: 10px 18px; font-size: 11px; font-weight: 600; color: var(--text-3);
    cursor: pointer; border: none; border-bottom: 2px solid transparent;
    background: none; text-transform: uppercase; letter-spacing: 0.5px;
    white-space: nowrap; transition: color .15s, border-color .15s;
  }
  .tab:hover { color: var(--text-2); }
  .tab.active { color: var(--gold); border-bottom-color: var(--gold); }

  /* ── Onboarding ────────────────────────────────── */
  .onboarding { max-width: 680px; margin: 0 auto; }
  .onboarding-hero { text-align: center; padding: 32px 0 24px; }
  .hero-icon { font-size: 56px; margin-bottom: 12px; }
  .hero-title { font-size: 20px; font-weight: 600; color: var(--text-1); margin: 0 0 8px; }
  .hero-sub { font-size: 13px; color: var(--text-3); line-height: 1.6; max-width: 500px; margin: 0 auto; }

  /* ── Category Bars ─────────────────────────────── */
  .cat-grid { display: flex; flex-direction: column; gap: 6px; }
  .cat-row { display: flex; align-items: center; gap: 10px; background: none; border: none; width: 100%; text-align: left; padding: 4px 0; }
  .cat-row.clickable { cursor: pointer; border-radius: 6px; padding: 6px 8px; transition: background .15s; }
  .cat-row.clickable:hover { background: var(--surface-2); }
  .cat-label { display: flex; align-items: center; gap: 6px; min-width: 130px; }
  .cat-icon { font-size: 16px; }
  .cat-name { font-size: 12px; font-weight: 500; color: var(--text-1); }
  .cat-bar-wrap { flex: 1; height: 22px; background: var(--surface-3); border-radius: 6px; overflow: hidden; }
  .cat-bar { height: 100%; border-radius: 6px; transition: width .4s ease; display: flex; align-items: center; padding-left: 8px; min-width: 28px; }
  .cat-bar-label { font-size: 10px; color: rgba(255,255,255,.85); font-weight: 600; }
  .cat-size { font-size: 11px; color: var(--text-2); min-width: 70px; text-align: right; font-weight: 500; }

  /* ── Two Column Layout ─────────────────────────── */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }

  /* ── Extension List ────────────────────────────── */
  .ext-list { display: flex; flex-direction: column; gap: 2px; }
  .ext-row { display: flex; align-items: center; gap: 8px; padding: 5px 4px; background: none; border: none; width: 100%; text-align: left; }
  .ext-row.clickable { cursor: pointer; border-radius: 4px; transition: background .15s; }
  .ext-row.clickable:hover { background: var(--surface-2); }
  .ext-rank { font-size: 10px; color: var(--text-3); width: 20px; text-align: right; }
  .ext-name { font-size: 13px; font-weight: 600; color: var(--teal); min-width: 55px; font-family: var(--font-mono); }
  .ext-bar-wrap { flex: 1; height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
  .ext-bar { height: 100%; border-radius: 3px; background: var(--teal); opacity: .5; }
  .ext-count { font-size: 12px; color: var(--text-1); font-weight: 500; min-width: 40px; text-align: right; }
  .ext-size { font-size: 11px; color: var(--text-3); min-width: 65px; text-align: right; }

  /* ── File Rows (overview) ───────────────────────── */
  .file-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .file-row:last-child { border-bottom: none; }
  .file-rank { font-size: 12px; font-weight: 700; width: 20px; text-align: center; }
  .file-info { flex: 1; min-width: 0; }
  .file-name { font-size: 13px; font-weight: 500; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .file-path { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .7; }
  .file-size { font-size: 12px; font-weight: 600; white-space: nowrap; }
  .meta-sep { opacity: .4; }

  /* ── Scan Cards ────────────────────────────────── */
  .scan-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .scan-card { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; transition: border-color .2s; }
  .scan-card:hover { border-color: var(--blue); }
  .scan-card.row { display: flex; align-items: center; gap: 12px; }
  .scan-card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .scan-card-icon { font-size: 16px; }
  .scan-label { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .scan-path { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scan-path-inline { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scan-status { font-size: 11px; color: var(--text-3); display: flex; align-items: center; gap: 6px; }
  .scan-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .scan-dot.active { background: var(--green); }
  .scan-dot.pending { background: var(--gold); }

  /* ── Duplicate Banner ──────────────────────────── */
  .dup-banner { display: flex; align-items: center; gap: 14px; background: color-mix(in srgb, var(--orange) 8%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--orange) 25%, var(--border)); border-radius: 10px; padding: 14px 18px; margin-top: 6px; }
  .dup-icon { font-size: 28px; }
  .dup-text { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--text-2); line-height: 1.4; }
  .dup-text strong { color: var(--orange); }

  /* ── Browse Layout ─────────────────────────────── */
  .browse-layout { display: grid; grid-template-columns: 240px 1fr; gap: 16px; }
  @media (max-width: 900px) { .browse-layout { grid-template-columns: 1fr; } }

  .browse-sidebar {
    display: flex; flex-direction: column; gap: 2px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px; max-height: calc(100vh - 180px); overflow-y: auto;
  }
  .sidebar-section { margin-bottom: 14px; }
  .sidebar-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--text-3); margin-bottom: 8px; }

  .filter-pills { display: flex; flex-wrap: wrap; gap: 4px; }
  .ext-pills { max-height: 200px; overflow-y: auto; }
  .pill {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px;
    padding: 4px 10px; font-size: 11px; color: var(--text-2); cursor: pointer;
    transition: all .15s; display: flex; align-items: center; gap: 4px; white-space: nowrap;
  }
  .pill.sm { padding: 3px 8px; font-size: 10px; }
  .pill:hover { border-color: var(--gold); color: var(--text-1); }
  .pill.on { background: color-mix(in srgb, var(--gold) 15%, var(--surface-2)); border-color: var(--gold); color: var(--gold); }
  .pill-cnt { font-size: 9px; opacity: .6; }

  .sort-row { display: flex; gap: 6px; align-items: center; }
  .sort-dir { background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; cursor: pointer; color: var(--text-2); font-size: 12px; }

  .browse-main { min-width: 0; }
  .browse-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .browse-count { font-size: 12px; color: var(--text-2); font-weight: 500; }
  .browse-loading { font-size: 11px; color: var(--gold); }

  .browse-list { display: flex; flex-direction: column; }
  .browse-file {
    display: flex; gap: 10px; align-items: flex-start; padding: 10px 8px;
    border-bottom: 1px solid var(--border); transition: background .1s;
  }
  .browse-file:hover { background: var(--surface-2); }
  .browse-file:last-child { border-bottom: none; }
  .bf-icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; }
  .bf-info { flex: 1; min-width: 0; }
  .bf-name { font-size: 13px; font-weight: 500; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bf-meta { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 11px; color: var(--text-3); flex-wrap: wrap; }
  .bf-snippet { font-size: 11px; color: var(--text-3); margin-top: 4px; line-height: 1.4; opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .pagination { display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 16px; padding: 12px 0; }
  .page-btn { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; font-size: 12px; color: var(--text-2); cursor: pointer; }
  .page-btn:disabled { opacity: .4; cursor: default; }
  .page-info { font-size: 12px; color: var(--text-3); }

  .empty-state { text-align: center; color: var(--text-3); font-size: 13px; padding: 40px 20px; font-style: italic; }

  /* ── Search ────────────────────────────────────── */
  .search-section { max-width: 900px; }
  .search-hint { font-size: 12px; color: var(--text-3); margin: 0 0 12px; line-height: 1.5; }

  .search-result {
    display: flex; gap: 10px; align-items: flex-start; padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .search-result:last-child { border-bottom: none; }
  .sr-rank { font-size: 11px; font-weight: 700; color: var(--text-3); min-width: 20px; text-align: center; margin-top: 2px; }
  .sr-icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; }
  .sr-info { flex: 1; min-width: 0; }
  .sr-name { font-size: 13px; font-weight: 600; color: var(--text-1); margin-bottom: 4px; }
  .sr-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); flex-wrap: wrap; }
  .sr-path { font-family: var(--font-mono); font-size: 10px; }
  .sr-snippet { font-size: 11px; color: var(--text-3); margin-top: 6px; line-height: 1.5; opacity: .7; }

  .sr-score { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 36px; }
  .score-bar { width: 4px; background: var(--green); border-radius: 2px; min-height: 4px; transition: height .3s; align-self: flex-end; }
  .score-val { font-size: 10px; font-weight: 700; color: var(--green); }

  /* ── Organize ──────────────────────────────────── */
  .organize-section { max-width: 1000px; }
  .org-hint { font-size: 12px; color: var(--text-3); margin: 0 0 14px; line-height: 1.5; }
  .org-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  .vtree { display: flex; flex-direction: column; gap: 2px; }
  .vtree-folder { margin-bottom: 2px; }
  .vtree-header {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px; width: 100%;
    background: none; border: none; cursor: pointer; border-radius: 6px;
    transition: background .1s; text-align: left; color: var(--text-1);
  }
  .vtree-header:hover { background: var(--surface-2); }
  .vtree-header.sub { padding-left: 32px; }
  .vtree-arrow { font-size: 10px; color: var(--text-3); width: 12px; }
  .vtree-icon { font-size: 18px; }
  .vtree-icon-sm { font-size: 14px; }
  .vtree-name { font-size: 13px; font-weight: 600; flex: 1; }
  .vtree-count { font-size: 11px; color: var(--text-3); }
  .vtree-size { font-size: 11px; color: var(--text-2); font-weight: 500; min-width: 60px; text-align: right; }

  .vtree-sub { margin-left: 0; }
  .vtree-files { padding-left: 56px; }
  .vtree-files.indent { padding-left: 56px; }
  .vtree-file { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 12px; color: var(--text-2); }
  .vtree-file-icon { font-size: 12px; }
  .vtree-file-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vtree-file-size { font-size: 10px; color: var(--text-3); min-width: 50px; text-align: right; }
  .vtree-more { font-size: 11px; color: var(--text-3); font-style: italic; padding: 4px 0; }

  /* ── Buttons ─────────────────────────────────── */
  .btn-primary { background: var(--blue); color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity .15s; }
  .btn-primary:hover { opacity: .85; }
  .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
  .btn-primary.btn-sm { padding: 5px 12px; font-size: 12px; }
  .btn-primary.gold { background: var(--gold); }
  .btn-ghost { background: none; border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; font-size: 12px; color: var(--text-2); cursor: pointer; }
  .btn-ghost:hover { border-color: var(--text-3); }
  .btn-scan { background: var(--green); color: #fff; border: none; border-radius: 5px; padding: 5px 12px; font-size: 11px; font-weight: 600; cursor: pointer; transition: opacity .15s; white-space: nowrap; }
  .btn-scan:hover { opacity: .85; }
  .btn-scan:disabled { opacity: .5; cursor: not-allowed; }
  .btn-scan.sm { padding: 3px 8px; font-size: 10px; margin-left: auto; }
  .mt12 { margin-top: 12px; }

  /* ── Add Directory Form ──────────────────────── */
  .add-form { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
  .add-form-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .add-form-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .form-row { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .form-field { display: flex; flex-direction: column; gap: 4px; min-width: 160px; }
  .form-field.grow { flex: 1; }
  .form-field.cb { justify-content: flex-end; }
  .form-field label { font-size: 11px; font-weight: 500; color: var(--text-2); display: flex; align-items: center; gap: 6px; }
  .form-field .hint { color: var(--text-3); font-weight: 400; }
  .form-field input[type="text"] {
    background: var(--bg); border: 1px solid var(--border); border-radius: 5px;
    padding: 7px 10px; font-size: 13px; color: var(--text-1);
    font-family: inherit; outline: none; transition: border-color .15s;
  }
  .form-field input[type="text"]:focus { border-color: var(--blue); }
  .form-field input[type="checkbox"] { accent-color: var(--blue); }
  .config-hint { font-size: 12px; color: var(--gold); margin: 0 0 10px; }
</style>
